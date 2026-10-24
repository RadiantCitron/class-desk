import { test, expect, type Page } from "@playwright/test";
import {
  admin,
  createApprovedOrder,
  createCourseOffering,
  createTestUser,
  deleteCourseOffering,
  loginAs,
  payWithTossSuccess,
  resetGates,
  retireTestUser,
  setActivePaymentProvider,
  tossPaymentKey,
  triggerTossWebhook,
  waitOrderPaymentStatus,
} from "./helpers";

// 폐강 중 「수강생 처리」의 일괄 PG 환불(전액 / 같은 금액 부분)을 화면에서 끝까지 확인한다. [로컬] 전용(가짜 토스).
// 환불은 PG 취소가 수락된 뒤 웹훅으로 확정되므로, 확정은 웹훅 수동 트리거로 대신한다(admin-refund-ui와 같은 방식).
test.describe("폐강 일괄 환불 (전액 / 부분)", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let students: Awaited<ReturnType<typeof createTestUser>>[] = [];
  let courseId: string;
  let offeringId: string;
  let orderIds: string[] = [];
  const price = 30_000;

  const section = (page: Page) => page.getByTestId("student-processing");
  const dialogWith = (page: Page, text: string) => page.getByRole("alertdialog").filter({ hasText: text });

  async function payAll(page: Page) {
    for (const [i, student] of students.entries()) {
      await loginAs(page, student.email, student.password);
      await payWithTossSuccess(page, orderIds[i]);
    }
  }

  test.beforeEach(async ({ page }) => {
    await resetGates();
    adminUser = await createTestUser({ role: "ADMIN", name: "관리자" });
    await setActivePaymentProvider("TOSS", adminUser.id);
    students = [
      await createTestUser({ role: "STUDENT", name: "학생일", phone: "010-1000-0001" }),
      await createTestUser({ role: "STUDENT", name: "학생이", phone: "010-1000-0002" }),
    ];
    ({ courseId, offeringId } = await createCourseOffering({ price, capacity: 5 }));
    orderIds = [];
    for (const s of students) orderIds.push(await createApprovedOrder(s.id, offeringId, price));
    await payAll(page);

    // 폐강 시작(시작 자체는 기존 기능) — 결제 완료 두 명은 자동 환불 없이 처리 대기로 남는다.
    const { error } = await admin.rpc("cancel_course_offering", {
      p_offering_id: offeringId,
      p_reason: "e2e 폐강",
      p_actor: adminUser.id,
      p_actor_role: "ADMIN",
    });
    if (error) throw new Error(error.message);
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(section(page)).toBeVisible();
    await section(page).getByLabel("전체 선택").check();
  });

  test.afterEach(async () => {
    for (const id of orderIds) {
      await admin.from("entitlements").delete().eq("order_id", id);
      await admin.from("dead_letters").delete().contains("payload", { order_id: id });
      await admin.from("outbox_messages").delete().contains("payload", { order_id: id });
    }
    for (const s of students) await retireTestUser(s);
    await retireTestUser(adminUser);
    await deleteCourseOffering(offeringId, courseId).catch(() => undefined);
  });

  test("일괄 부분 환불: 같은 금액을 요청 → 웹훅 후 PARTIALLY_REFUNDED + 신청 종료(수강 포기) → 바로 폐강 완료", async ({ page }) => {
    await page.getByRole("button", { name: "선별·일괄 환불(PG)" }).click();
    const modal = dialogWith(page, "선별·일괄 환불");
    await expect(modal).toBeVisible();

    // 모드: 같은 금액 선택
    await modal.locator("select").selectOption("fixed");
    await modal.locator('input[placeholder="예: 10000"]').fill("10000");
    await modal.getByRole("button", { name: "미리보기 조회" }).click();

    await expect(modal.getByText("총 결정 환불액: 20,000원")).toBeVisible();
    await modal.getByPlaceholder(/폐강에 따른 수강생 일괄 환불/).fill("e2e 일부 환불");
    await modal.getByRole("button", { name: "위 내용대로 일괄 환불 요청 확정" }).click();

    await expect(page.getByText(/2건 환불 요청 완료/)).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "확인" }).first().click();

    // 원장: 두 주문 모두 10,000원 환불 요청 1건씩(감사 로그도 주문마다 1건)
    const { data: requests } = await admin.from("payment_events").select("order_id, amount").in("order_id", orderIds).eq("event_type", "REFUND_REQUESTED");
    expect(requests?.map((r) => r.amount)).toEqual([10_000, 10_000]);
    const { data: audits } = await admin.from("audit_logs").select("target_id, detail").eq("action", "PAYMENT_REFUND_REQUEST").eq("phase", "SUCCEEDED").in("target_id", orderIds);
    expect(audits).toHaveLength(2);

    // 웹훅이 오면 부분 환불이 반영되고 부분 환불도 수강 포기라 신청이 끝난다 — 주문 CANCELLED, 결제 PARTIALLY_REFUNDED
    for (const id of orderIds) await triggerTossWebhook(await tossPaymentKey(id));
    for (const id of orderIds) {
      const order = await waitOrderPaymentStatus(id, "PARTIALLY_REFUNDED");
      expect(order.refunded_amount).toBe(10_000);
      const { data: o } = await admin.from("orders").select("status").eq("id", id).single();
      expect(o?.status).toBe("CANCELLED");
      const { data: ev } = await admin.from("order_events").select("payload").eq("order_id", id).eq("event_type", "CANCELLED").single();
      expect(ev?.payload).toMatchObject({ partial: true, refunded_total: 10_000 });
    }

    // 처리할 수강생이 남지 않아 「환불 없이 종료」 없이 바로 폐강을 완료할 수 있다
    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(page.getByText("처리할 수강생이 없습니다")).toBeVisible();
    const complete = page.getByRole("button", { name: "폐강 마무리 확인" });
    await expect(complete).toBeEnabled();
    await complete.click();
    await expect(page.getByText("폐강을 완료했습니다").first()).toBeVisible({ timeout: 30_000 });
  });

  test("일괄 전액 환불: 웹훅 후 REFUNDED·CANCELLED(자동 종료) → 폐강 완료", async ({ page }) => {
    await page.getByRole("button", { name: "선별·일괄 환불(PG)" }).click();
    const modal = dialogWith(page, "선별·일괄 환불");
    await expect(modal).toBeVisible();

    // 모드: 전액 기준
    await modal.locator("select").selectOption("full");
    await modal.getByRole("button", { name: "미리보기 조회" }).click();

    await expect(modal.getByText("총 결정 환불액: 60,000원")).toBeVisible();
    await modal.getByPlaceholder(/폐강에 따른 수강생 일괄 환불/).fill("e2e 전액 환불");
    await modal.getByRole("button", { name: "위 내용대로 일괄 환불 요청 확정" }).click();

    await expect(page.getByText(/2건 환불 요청 완료/)).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "확인" }).first().click();

    for (const id of orderIds) await triggerTossWebhook(await tossPaymentKey(id));
    for (const id of orderIds) {
      await waitOrderPaymentStatus(id, "REFUNDED");
      const { data: o } = await admin.from("orders").select("status").eq("id", id).single();
      expect(o?.status).toBe("CANCELLED");
    }

    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(page.getByText("처리할 수강생이 없습니다")).toBeVisible();
    const complete = page.getByRole("button", { name: "폐강 마무리 확인" });
    await expect(complete).toBeEnabled();
    await complete.click();
    await expect(page.getByText("폐강을 완료했습니다").first()).toBeVisible({ timeout: 30_000 });
  });

  test("부분 환불 금액이 환불 가능액보다 크면 미리보기에서 제외 표시가 된다", async ({ page }) => {
    await page.getByRole("button", { name: "선별·일괄 환불(PG)" }).click();
    const modal = dialogWith(page, "선별·일괄 환불");
    await modal.locator("select").selectOption("fixed");
    await modal.locator('input[placeholder="예: 10000"]').fill("40000");
    await modal.getByRole("button", { name: "미리보기 조회" }).click();

    await expect(modal.getByText(/환불 가능액.*초과/)).toHaveCount(2);
    await expect(modal.getByText("총 결정 환불액: 0원")).toBeVisible();
  });
});
