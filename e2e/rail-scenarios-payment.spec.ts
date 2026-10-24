import { test, expect, type Page } from "@playwright/test";
import {
  admin,
  createApprovedOrder,
  createCourseOffering,
  createTestUser,
  deleteCourseOffering,
  insertRailSwitch,
  loginAs,
  payWithTossSuccess,
  resetGates,
  retireTestUser,
  setActivePaymentProvider,
  waitOrderPaymentStatus,
} from "./helpers";

// 명령 레일 검증 시나리오 — 결제가 끝난 주문이 필요한 것.
// 결제는 토스(가짜 PG)로 한다. 준비는 admin-refund-ui.spec.ts와 같다.
const refundDialog = (page: Page) => page.getByRole("alertdialog").filter({ hasText: "환불을 요청할까요?" });
const manualDialog = (page: Page) => page.getByRole("alertdialog").filter({ hasText: "PG 외 환불을 원장에 반영할까요?" });
const resultDialog = (page: Page, ok: boolean) =>
  page.getByRole("alertdialog", { name: ok ? "✔ 처리되었습니다" : "✖ 실패했습니다" });

test.describe("명령 레일 — 결제 완료 주문의 명령 단위 봉쇄", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let orderId: string;
  const price = 30_000;

  test.beforeEach(async ({ page }) => {
    await resetGates();
    adminUser = await createTestUser({ role: "ADMIN", name: "관리자" });
    await setActivePaymentProvider("TOSS", adminUser.id);
    student = await createTestUser({ role: "STUDENT", name: "홍길동", phone: "010-1111-2222" });
    ({ courseId, offeringId } = await createCourseOffering({ price }));
    orderId = await createApprovedOrder(student.id, offeringId, price);
    await loginAs(page, student.email, student.password);
    await payWithTossSuccess(page, orderId);
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto(`/admin/orders/${orderId}`);
  });

  test.afterEach(async () => {
    await resetGates();
    if (student) await retireTestUser(student);
    if (adminUser) await retireTestUser(adminUser);
    if (offeringId && courseId) await deleteCourseOffering(offeringId, courseId);
  });

  test("환불 요청(PAYMENT_REFUND_REQUEST)만 막히고, 같은 화면의 PG 외 환불 반영(PAYMENT_REFUND_MANUAL)은 통과한다", async ({ page }) => {
    const switchId = await insertRailSwitch({
      level: "COMMAND",
      target: "PAYMENT_REFUND_REQUEST",
      setBy: adminUser.id,
      reason: "e2e 테스트 — 환불 점검",
    });

    // 환불 요청 → 레일이 거부한다(실패 팝업). 주문은 결제 완료 그대로, 환불 기록 없음.
    await page.getByRole("button", { name: "환불 요청", exact: true }).click();
    const dialog = refundDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.locator('textarea[name="reason"]').fill("e2e 환불 요청 — 막혀야 한다");
    await dialog.getByRole("button", { name: "환불 요청 확정" }).click();
    const failPopup = resultDialog(page, false);
    await expect(failPopup).toBeVisible({ timeout: 30_000 });
    await expect(failPopup).toContainText("환불 요청 기능이 일시 중단되었습니다: e2e 테스트 — 환불 점검");
    await failPopup.getByRole("button", { name: "확인" }).click();
    await expect(failPopup).toHaveCount(0);

    const { data: order } = await admin.from("orders").select("payment_status, refunded_amount").eq("id", orderId).single();
    expect(order?.payment_status).toBe("PAID");
    expect(order?.refunded_amount ?? 0).toBe(0);
    const { data: refunded } = await admin.from("payment_events").select("id").eq("order_id", orderId).eq("event_type", "REFUNDED");
    expect(refunded).toEqual([]);

    // 감사: FAILED + 어느 층의 어느 스위치에 막혔는지.
    const { data: denied } = await admin
      .from("audit_logs")
      .select("phase, detail")
      .eq("action", "PAYMENT_REFUND_REQUEST")
      .eq("target_id", orderId)
      .eq("phase", "FAILED");
    expect(denied?.[0]?.detail).toMatchObject({ rail_denied: { check: "SWITCH", layer: "COMMAND", switchId } });

    // 같은 주문의 다른 명령 — PG 외 환불 반영은 막히지 않아 그대로 처리된다.
    await page.getByRole("button", { name: "PG 외 환불 반영" }).click();
    const manual = manualDialog(page);
    await expect(manual).toBeVisible();
    await manual.locator('textarea[name="reason"]').fill("e2e PG 외 환불 — 통과해야 한다");
    await manual.getByRole("button", { name: "원장 반영" }).click();
    const okPopup = resultDialog(page, true);
    await expect(okPopup).toBeVisible({ timeout: 30_000 });
    await okPopup.getByRole("button", { name: "확인" }).click();

    const done = await waitOrderPaymentStatus(orderId, "REFUNDED", 60_000);
    expect(done.refunded_amount).toBe(price);
  });
});
