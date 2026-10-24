import { test, expect } from "@playwright/test";
import {
  createTestUser,
  retireTestUser,
  createCourseOffering,
  deleteCourseOffering,
  createApprovedOrder,
  loginAs,
  admin,
} from "./helpers";

// 강의 종료 = 전부 회수, 그리고 종료 취소. [로컬] 전용(Playwright가 띄운 개발 서버 + 로컬 DB).
test.describe("강의 종료·종료 취소", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let courseName: string;
  let orderId: string;
  const price = 50_000;
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

  test.beforeEach(async () => {
    adminUser = await createTestUser({ role: "ADMIN" });
    student = await createTestUser({ role: "STUDENT", name: "수료생", phone: "010-0000-0003" });
    ({ courseId, offeringId, courseName } = await createCourseOffering({ price }));

    // 이미 끝난 강의로 만든다: 모집 10일 전·개강 5일 전·종강 1일 전. 결제 완료 주문 + 이용권 1건.
    await admin
      .from("course_offerings")
      .update({ recruit_opens_at: day(-10), opens_at: day(-5), ends_at: day(-1) })
      .eq("id", offeringId);
    orderId = await createApprovedOrder(student.id, offeringId, price);
    await admin
      .from("orders")
      .update({ payment_status: "PAID", paid_at: new Date().toISOString(), payment_method: "CARD" })
      .eq("id", orderId);
    const { data: payment } = await admin
      .from("payment_events")
      .insert({
        provider: "TOSS",
        provider_event_id: `e2e-e3-${orderId}`,
        provider_transaction_id: `e2e-e3-key-${orderId}`,
        event_type: "PAYMENT_SUCCEEDED",
        amount: price,
        currency: "KRW",
        order_id: orderId,
        payment_method: "CARD",
      })
      .select("id")
      .single();
    await admin.rpc("grant_entitlements_for_order", {
      p_order_id: orderId,
      p_user_id: student.id,
      p_source: "PAYMENT",
      p_source_id: payment!.id,
      p_grants: null,
    });
  });

  test.afterEach(async () => {
    // 주문·원장·주문 이벤트는 지우지 않는다(잔여는 db:reset). 테스트가 만든 이용권·경고·사실만 치운다.
    await admin.from("entitlements").delete().eq("order_id", orderId);
    await admin.from("dead_letters").delete().contains("payload", { order_id: orderId });
    await admin.from("outbox_messages").delete().contains("payload", { order_id: orderId });
    await retireTestUser(adminUser);
    await retireTestUser(student);
    await deleteCourseOffering(offeringId, courseId).catch(() => undefined);
  });

  test("종강일이 지난 강의: 종료 처리 대기 표시 → 비고와 함께 종료 → 이용권 회수·종료 기록·감사 로그 → 학생 화면 종료 → 종료 취소로 재부여", async ({ page }) => {
    await loginAs(page, adminUser.email, adminUser.password);

    // 목록과 상세 모두 「종료 처리 대기」
    await page.goto("/admin/course-offerings");
    await expect(page.locator("tbody tr", { hasText: courseName })).toContainText("종료 처리 대기");
    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(page.locator("section", { hasText: "기본 정보" }).first()).toContainText("종료 처리 대기");

    // 종료 모달 — 비고가 비면 제출되지 않는다
    const endDialog = page.getByRole("alertdialog").filter({ hasText: "강의를 종료할까요?" });
    await expect(async () => {
      await page.getByRole("button", { name: "강의 종료", exact: true }).click();
      await expect(endDialog).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await endDialog.getByRole("button", { name: "종료 확정" }).click();
    const { data: stillOpen } = await admin.from("course_offerings").select("ended_at").eq("id", offeringId).single();
    expect(stillOpen?.ended_at).toBeNull();

    await endDialog.getByPlaceholder(/종료 비고|정상 강의 완료/).fill("e2e 정상 강의 완료");
    await endDialog.getByRole("button", { name: "종료 확정" }).click();
    await expect(page.getByText(/강의를 종료했습니다/).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "확인" }).first().click();

    // 종료 기록이 상세에 보이고, 종료 버튼은 사라지고 종료 취소가 나온다
    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(page.getByTestId("end-record")).toContainText("e2e 정상 강의 완료");
    await expect(page.getByTestId("end-record")).toContainText(adminUser.email);
    await expect(page.locator("section", { hasText: "기본 정보" }).first()).toContainText("종료");
    await expect(page.getByRole("button", { name: "강의 종료", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "종료 취소", exact: true })).toBeVisible();

    // DB: 이용권 회수(COURSE_ENDED), 주문·결제 상태 그대로, 감사 로그
    await expect
      .poll(async () => {
        const { data } = await admin.from("entitlements").select("revoked_reason").eq("order_id", orderId);
        return (data ?? []).map((e) => e.revoked_reason).join(",");
      })
      .toBe("COURSE_ENDED");
    const { data: order } = await admin.from("orders").select("status, payment_status").eq("id", orderId).single();
    expect(order).toMatchObject({ status: "APPROVED", payment_status: "PAID" });
    const { data: audits } = await admin
      .from("audit_logs")
      .select("phase, detail")
      .eq("action", "COURSE_OFFERING_END")
      .eq("target_id", offeringId);
    expect((audits ?? []).some((a) => a.phase === "SUCCEEDED" && (a.detail as { note?: string }).note === "e2e 정상 강의 완료")).toBe(true);

    // 학생 홈에 「종료」
    await loginAs(page, student.email, student.password);
    await page.goto("/student");
    await expect(page.getByTestId("lifecycle-text").first()).toContainText("종료");
    await expect(page.getByTestId("lifecycle-text").first()).not.toContainText("처리 대기");

    // 종료 취소 — 사유 필수, 새 이용권 재부여, 수동 종료 설정이 켜진다
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto(`/admin/course-offerings/${offeringId}`);
    const cancelDialog = page.getByRole("alertdialog").filter({ hasText: "강의 종료를 취소할까요?" });
    await expect(async () => {
      await page.getByRole("button", { name: "종료 취소", exact: true }).click();
      await expect(cancelDialog).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await cancelDialog.getByPlaceholder(/종료 취소 사유|종강일/).fill("e2e 종강일 입력 오류");
    await cancelDialog.getByRole("button", { name: "종료 취소 확정" }).click();
    await expect(page.getByText(/강의 종료를 취소했습니다/).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "확인" }).first().click();

    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(page.getByTestId("end-record")).toHaveCount(0);
    await expect(page.getByText("켜짐(크론이 자동 종료하지 않음)")).toBeVisible();
    await expect(page.getByRole("button", { name: "강의 종료", exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const { data } = await admin.from("entitlements").select("grant_source, revoked_at").eq("order_id", orderId);
        const active = (data ?? []).filter((e) => e.revoked_at === null);
        return `${data?.length}:${active.map((e) => e.grant_source).join(",")}`;
      })
      .toBe("2:ADMIN_GRANT");
  });

  test("개강 전·종강 전 강의에는 종료 버튼이 없다(기간 중 중단은 폐강)", async ({ page }) => {
    await admin.from("course_offerings").update({ opens_at: day(5), ends_at: day(30), recruit_opens_at: day(-1) }).eq("id", offeringId);
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(page.getByRole("button", { name: "폐강", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "강의 종료", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "종료 취소", exact: true })).toHaveCount(0);
  });

  test("종료된 강의는 학생의 신청 목록에서 숨겨지고, 이미 신청한 사람의 「내 수강 내역」에는 그대로 보인다", async ({ page }) => {
    await loginAs(page, student.email, student.password);
    await page.goto("/student");
    // 종강일이 지났어도 종료 전에는 모집 마감(개강) 비활성 행으로 목록에 있다(기존 동작)
    await expect(page.locator("li", { hasText: courseName })).toHaveCount(1);

    await admin
      .from("course_offerings")
      .update({ ended_at: new Date().toISOString(), end_note: "e2e 종료" })
      .eq("id", offeringId);
    await page.goto("/student");
    await expect(page.locator("li", { hasText: courseName })).toHaveCount(0);
    // 내 수강 내역(이미 신청한 주문)은 그대로
    await expect(page.locator("tbody tr", { hasText: courseName })).toHaveCount(1);
  });

  test("개설강의 목록: 마감(CLOSED) 행에도 폐강 버튼이 있고 「먼저 재개」 안내는 없으며, 종료된 강의 행에는 마감/재개·폐강 버튼이 없다", async ({ page }) => {
    await loginAs(page, adminUser.email, adminUser.password);

    // 마감 상태로 바꾼다(상태 변경에는 사유·행위자·시각이 필요하다)
    await admin
      .from("course_offerings")
      .update({ status: "CLOSED", status_reason: "e2e 마감", status_changed_by: adminUser.id, status_changed_at: new Date().toISOString() })
      .eq("id", offeringId);
    await page.goto("/admin/course-offerings");
    const row = page.locator("tbody tr", { hasText: courseName });
    await expect(row.getByRole("button", { name: "폐강", exact: true })).toBeVisible();
    await expect(row.getByText("먼저 재개한 뒤 폐강하세요")).toHaveCount(0);

    // 종료 기록이 생기면 마감/재개·폐강이 사라진다
    await admin.from("course_offerings").update({ ended_at: new Date().toISOString(), end_note: "e2e 종료" }).eq("id", offeringId);
    await page.goto("/admin/course-offerings");
    await expect(row).toContainText("종료");
    await expect(row.getByRole("button", { name: "폐강", exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "재개", exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "마감", exact: true })).toHaveCount(0);
  });
});
