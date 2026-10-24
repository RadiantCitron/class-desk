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

// 폐강은 환불을 자동 개시하지 않는다. 결제 완료·무료(직권 부여) 수강생을 관리자가 학생별로 처리해야
// 폐강을 마무리할 수 있다. [로컬] 전용(Playwright가 띄운 개발 서버 + 로컬 DB).
test.describe("폐강 학생별 처리", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let paidStudent: Awaited<ReturnType<typeof createTestUser>>;
  let waivedStudent: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let paidOrderId: string;
  let waivedOrderId: string;
  const price = 50_000;

  test.beforeEach(async () => {
    adminUser = await createTestUser({ role: "ADMIN" });
    paidStudent = await createTestUser({ role: "STUDENT", name: "결제 수강생", phone: "010-0000-0001" });
    waivedStudent = await createTestUser({ role: "STUDENT", name: "초대 수강생", phone: "010-0000-0002" });
    ({ courseId, offeringId } = await createCourseOffering({ price }));

    // 결제 완료 주문(결제 상태를 직접 PAID로) + 이용권 1건, 직권 부여 주문(WAIVED)은 DB 함수로.
    paidOrderId = await createApprovedOrder(paidStudent.id, offeringId, price);
    await admin
      .from("orders")
      .update({ payment_status: "PAID", paid_at: new Date().toISOString(), payment_method: "CARD" })
      .eq("id", paidOrderId);
    const { data: payment } = await admin
      .from("payment_events")
      .insert({
        provider: "TOSS",
        provider_event_id: `e2e-e4-${paidOrderId}`,
        provider_transaction_id: `e2e-e4-key-${paidOrderId}`,
        event_type: "PAYMENT_SUCCEEDED",
        amount: price,
        currency: "KRW",
        order_id: paidOrderId,
        payment_method: "CARD",
      })
      .select("id")
      .single();
    await admin.rpc("grant_entitlements_for_order", {
      p_order_id: paidOrderId,
      p_user_id: paidStudent.id,
      p_source: "PAYMENT",
      p_source_id: payment!.id,
      p_grants: null,
    });

    waivedOrderId = await createApprovedOrder(waivedStudent.id, offeringId, price);
    const { error } = await admin.rpc("grant_order_access", {
      p_order_id: waivedOrderId,
      p_actor_id: adminUser.id,
      p_actor_role: "ADMIN",
      p_reason: "e2e 직권 부여",
    });
    if (error) throw new Error(error.message);
  });

  test.afterEach(async () => {
    // 주문·원장·주문 이벤트는 지우지 않는다(잔여는 db:reset). 테스트가 만든 이용권·경고·사실만 치운다.
    for (const id of [paidOrderId, waivedOrderId]) {
      await admin.from("entitlements").delete().eq("order_id", id);
      await admin.from("dead_letters").delete().contains("payload", { order_id: id });
      await admin.from("outbox_messages").delete().contains("payload", { order_id: id });
    }
    await retireTestUser(adminUser);
    await retireTestUser(paidStudent);
    await retireTestUser(waivedStudent);
    await deleteCourseOffering(offeringId, courseId);
  });

  test("폐강 시작 → 자동 환불 없음 → 체크박스로 일괄 환불 없이 종료 → 폐강 마무리 가능 → 완료", async ({ page }) => {
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto(`/admin/course-offerings/${offeringId}`);

    // 폐강 시작 — 모달에서 사유 입력
    const dialog = page.getByRole("alertdialog").filter({ hasText: "개설강의를 폐강할까요?" });
    await expect(async () => {
      await page.getByRole("button", { name: "폐강", exact: true }).click();
      await expect(dialog).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await dialog.getByPlaceholder("폐강 사유").fill("e2e 폐강");
    await dialog.getByRole("button", { name: "폐강 확정" }).click();
    await expect(page.getByText("폐강을 시작했습니다").first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "확인" }).first().click();

    // 자동 환불·종료는 없다: 두 주문 모두 그대로, 환불 요청 0건.
    const { data: orders } = await admin.from("orders").select("id, status, payment_status").in("id", [paidOrderId, waivedOrderId]);
    expect(orders?.find((o) => o.id === paidOrderId)).toMatchObject({ status: "APPROVED", payment_status: "PAID" });
    expect(orders?.find((o) => o.id === waivedOrderId)).toMatchObject({ status: "APPROVED", payment_status: "WAIVED" });
    const { count: requests } = await admin
      .from("payment_events")
      .select("id", { count: "exact", head: true })
      .eq("order_id", paidOrderId)
      .eq("event_type", "REFUND_REQUESTED");
    expect(requests).toBe(0);

    // 수강생 처리 목록에 두 명이 보이고 폐강 마무리는 비활성
    await page.goto(`/admin/course-offerings/${offeringId}`);
    const section = page.getByTestId("student-processing");
    await expect(section).toBeVisible();
    await expect(page.getByTestId(`processing-row-${paidOrderId}`)).toBeVisible();
    await expect(page.getByTestId(`processing-row-${waivedOrderId}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "폐강 마무리 확인" })).toBeDisabled();

    // 전체 선택 → 환불 없이 종료(사유 필수)
    await section.getByLabel("전체 선택").check();
    await section.getByRole("button", { name: "선택한 학생 환불 없이 종료" }).click();
    const closeDialog = page.getByRole("alertdialog").filter({ hasText: "환불 없이 종료할까요?" });
    await expect(closeDialog).toBeVisible();
    await closeDialog.getByPlaceholder(/종료 사유|강의 폐강/).fill("e2e 일괄 종료");
    await closeDialog.getByRole("button", { name: "환불 없이 종료", exact: true }).click();
    await expect(page.getByText(/2건을 환불 없이 종료했습니다/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "확인" }).first().click();

    // DB: 두 주문 CANCELLED, 결제 상태 그대로, 이용권 회수(ADMIN_CLOSED), 감사 기록 2건
    const { data: closed } = await admin.from("orders").select("id, status, payment_status").in("id", [paidOrderId, waivedOrderId]);
    expect(closed?.every((o) => o.status === "CANCELLED")).toBe(true);
    expect(closed?.find((o) => o.id === paidOrderId)?.payment_status).toBe("PAID");
    expect(closed?.find((o) => o.id === waivedOrderId)?.payment_status).toBe("WAIVED");
    await expect
      .poll(async () => {
        const { data } = await admin.from("entitlements").select("revoked_reason").in("order_id", [paidOrderId, waivedOrderId]);
        return (data ?? []).map((e) => e.revoked_reason).sort().join(",");
      })
      .toBe("ADMIN_CLOSED,ADMIN_CLOSED");
    const { data: audits } = await admin
      .from("audit_logs")
      .select("target_id")
      .eq("action", "ORDER_CLOSE_WITHOUT_REFUND")
      .eq("phase", "SUCCEEDED")
      .in("target_id", [paidOrderId, waivedOrderId]);
    expect(audits).toHaveLength(2);

    // 처리 목록이 비고 폐강 마무리 활성 → 완료
    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(page.getByText("처리할 수강생이 없습니다")).toBeVisible();
    const complete = page.getByRole("button", { name: "폐강 마무리 확인" });
    await expect(complete).toBeEnabled();
    await complete.click();
    await expect(page.getByText("폐강을 완료했습니다").first()).toBeVisible({ timeout: 30_000 });
    const { data: off } = await admin.from("course_offerings").select("status").eq("id", offeringId).single();
    expect(off?.status).toBe("CANCELLED");

    // 학생 홈: 환불 없이 종료된 결제 학생은 더 이상 「환불 대기」 배너를 보지 않는다.
    await loginAs(page, paidStudent.email, paidStudent.password);
    await page.goto("/student");
    await expect(page.getByText(/폐강 완료/).first()).toBeVisible();
    await expect(page.getByText(/담당자가 환불·정리를 개별로 처리/)).toHaveCount(0);
  });

  test("주문 상세에서도 폐강 중 학생을 사유와 함께 환불 없이 종료할 수 있다 — 사유가 없으면 종료되지 않는다", async ({ page }) => {
    await admin.rpc("cancel_course_offering", {
      p_offering_id: offeringId,
      p_reason: "e2e",
      p_actor: adminUser.id,
      p_actor_role: "ADMIN",
    });
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto(`/admin/orders/${paidOrderId}`);

    const box = page.getByTestId("close-without-refund");
    await expect(box).toBeVisible();
    await box.getByRole("button", { name: "환불 없이 종료" }).click(); // 사유 비어 있음 → 브라우저 필수 입력이 막는다
    const { data: still } = await admin.from("orders").select("status").eq("id", paidOrderId).single();
    expect(still?.status).toBe("APPROVED");

    await box.getByPlaceholder(/종료 사유/).fill("e2e 개별 종료");
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST" && res.ok()),
      box.getByRole("button", { name: "환불 없이 종료" }).click(),
    ]);
    await expect(page.getByTestId("close-without-refund")).toHaveCount(0);
    const { data: done } = await admin.from("orders").select("status, payment_status").eq("id", paidOrderId).single();
    expect(done).toMatchObject({ status: "CANCELLED", payment_status: "PAID" });
  });
});
