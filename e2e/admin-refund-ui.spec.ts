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

// 관리자 환불 모달: 부분환불 뒤에도 "전액" 선택이 서버에 full로 가야 한다.
// 부분환불 2번 뒤 "전액"을 눌러도 mode=partial로 제출된 결함의 회귀 테스트.

// 결제는 토스(가짜 PG)로 한다(페이앱은 2026-10-02 폐기). 토스의 앱 환불은 PG 취소가 수락된 뒤 웹훅으로 확정되므로,
// 환불 요청 직후에는 "PG 처리 중" 배너가 뜨고 환불 모달이 사라진다 — 확정은 웹훅 수동 트리거로 대신한다(G3와 같은 방식).

const refundDialog = (page: Page) => page.getByRole("alertdialog").filter({ hasText: "환불을 요청할까요?" });
// 결과 팝업(성공/실패) — 확정하면 입력 모달은 닫히고 이 팝업이 뜬다. 확인 버튼으로만 닫힌다(U 단계 3).
const resultDialog = (page: Page, ok: boolean) =>
  page.getByRole("alertdialog", { name: ok ? "✔ 처리되었습니다" : "✖ 실패했습니다" });

async function openRefundModal(page: Page) {
  await page.getByRole("button", { name: "환불 요청", exact: true }).click();
  await expect(refundDialog(page)).toBeVisible();
}

test.describe("관리자 환불 모달 — 전액/부분 선택(A1)", () => {
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
    if (student) await retireTestUser(student);
    if (adminUser) await retireTestUser(adminUser);
    if (offeringId && courseId) await deleteCourseOffering(offeringId, courseId);
  });

  test("처음 열 때 기본은 전액이고 금액칸은 숨겨져 있다", async ({ page }) => {
    await openRefundModal(page);
    const dialog = refundDialog(page);
    await expect(dialog.getByRole("radio", { name: /^전액/ })).toBeChecked();
    await expect(dialog.locator('input[name="partialAmount"]')).toBeHidden();

    await dialog.getByRole("radio", { name: "부분" }).click();
    await expect(dialog.locator('input[name="partialAmount"]')).toBeVisible();

    await dialog.getByRole("radio", { name: /^전액/ }).click();
    await expect(dialog.locator('input[name="partialAmount"]')).toBeHidden();
  });

  test("부분환불 뒤 같은 화면에서 전액을 고르면 금액 없이 전액(잔액)이 요청된다", async ({ page }) => {
    // 1) 부분환불 10000원
    await openRefundModal(page);
    let dialog = refundDialog(page);
    await dialog.getByRole("radio", { name: "부분" }).click();
    await dialog.locator('input[name="partialAmount"]').fill("10000");
    await dialog.locator('textarea[name="reason"]').fill("A1 부분환불");
    await dialog.getByRole("button", { name: "환불 요청 확정" }).click();
    // 성공하면 결과 팝업이 뜨고(아무 말 없이 끝나지 않는다), 입력 모달은 닫힌다. 배경·ESC로는 안 닫히고 확인으로만 닫힌다.
    const okPopup = resultDialog(page, true);
    await expect(okPopup).toBeVisible({ timeout: 30_000 });
    await expect(okPopup).toContainText("환불");
    await expect(okPopup).toContainText("통보(웹훅)");
    await expect(refundDialog(page)).toBeHidden(); // 닫힌 <dialog>는 DOM에 남아 있으므로 개수가 아니라 보이는지로 본다
    await page.mouse.click(2, 2);
    await page.keyboard.press("Escape");
    await expect(okPopup).toBeVisible();
    await okPopup.getByRole("button", { name: "확인" }).click();
    await expect(okPopup).toHaveCount(0);

    // 토스는 PG 취소 수락 뒤 웹훅으로 확정한다 — 웹훅을 수동으로 보낸다(서버가 가짜 토스에 결제를 다시 조회).
    await triggerTossWebhook(await tossPaymentKey(orderId));
    const partial = await waitOrderPaymentStatus(orderId, "PARTIALLY_REFUNDED", 60_000);
    expect(partial.refunded_amount).toBe(10_000);

    // 2) 부분환불이 확정된 화면에서 다시 환불 요청 — 전액을 선택한다.
    // 한계(2026-10-02 페이앱 폐기): 예전 이 테스트는 페이앱 통보가 응답 전에 처리돼 "새로고침 없이" 같은 화면에서 모달이 남는
    // 경로를 재현했다. 토스는 웹훅 확정이 화면 갱신을 일으키지 않아 새로고침이 필요하다 — 라디오 상태가 남는 옛 결함 경로는
    // 이 테스트로 재현되지 않고(수정은 CSS 표시로 이미 반영됨), 여기서는 부분→잔액 전액 흐름과 mode 전달만 검증한다.
    await page.reload();
    const trigger = page.getByRole("button", { name: "환불 요청", exact: true });
    await expect(trigger).toBeVisible();

    // 결과 팝업을 확인으로 닫았으니 환불 모달은 이미 닫혀 있다.
    await trigger.click();
    dialog = refundDialog(page);
    const reopened = `다시 연 직후: 전액 라디오 checked=${await dialog.getByRole("radio", { name: /^전액/ }).isChecked()}, 부분 라디오 checked=${await dialog.getByRole("radio", { name: "부분" }).isChecked()}, 금액칸 visible=${await dialog.locator('input[name="partialAmount"]').isVisible()}`;
    test.info().annotations.push({ type: "관찰", description: reopened });
    console.log(`[A1 관찰] ${reopened}`);
    // 다시 연 화면은 "전액"이 선택돼 있고(기본), 그렇다면 금액칸은 보이면 안 된다.
    // (사용자는 "전액"이 이미 선택돼 보여서 다시 누르지 않고, 보이는 금액칸에 금액을 넣었다.)
    await expect(dialog.getByRole("radio", { name: /^전액/ })).toBeChecked();
    await expect(dialog.locator('input[name="partialAmount"]')).toBeHidden();

    // 라디오를 다시 누르지 않고 그대로 사유만 넣어 제출 → 서버에는 full로 도착해야 한다.
    await dialog.locator('textarea[name="reason"]').fill("A1 잔액 전액환불");
    await dialog.getByRole("button", { name: "환불 요청 확정" }).click();

    const refundModes = async () => {
      const { data } = await admin
        .from("audit_logs")
        .select("detail, created_at")
        .eq("action", "PAYMENT_REFUND_REQUEST")
        .eq("target_id", orderId)
        .order("created_at", { ascending: true });
      return (data ?? [])
        .map((r) => (r.detail as { mode?: string } | null)?.mode)
        .filter((m): m is string => typeof m === "string");
    };
    await expect.poll(refundModes, { timeout: 30_000 }).toHaveLength(2);
    expect(await refundModes()).toEqual(["partial", "full"]);

    await triggerTossWebhook(await tossPaymentKey(orderId));
    const done = await waitOrderPaymentStatus(orderId, "REFUNDED", 60_000);
    expect(done.refunded_amount).toBe(price);
  });

  // U-4·R-4(2026-10-02): 전액 PG 외 환불을 반영하면 환불 가능액이 0이 되어 패널이 사라지던 탓에 결과 팝업도
  // 같이 사라졌다. 이제 팝업이 확인 전까지 남아야 하고, 환불 수단이 원장에 선택대로 기록돼야 한다.
  const manualDialog = (page: Page) =>
    page.getByRole("alertdialog").filter({ hasText: "PG 외 환불을 원장에 반영할까요?" });

  async function refundedMethod() {
    const { data } = await admin
      .from("payment_events")
      .select("provider, payment_method")
      .eq("order_id", orderId)
      .eq("event_type", "REFUNDED");
    return data ?? [];
  }

  test("PG 외 전액 환불 반영 뒤에도 결과 팝업이 확인 전까지 남고, 기본 환불 수단은 원결제 수단이다", async ({
    page,
  }) => {
    const { data: before } = await admin.from("orders").select("payment_method").eq("id", orderId).single();
    expect(before?.payment_method).toBeTruthy();

    await page.getByRole("button", { name: "PG 외 환불 반영" }).click();
    const dialog = manualDialog(page);
    await expect(dialog).toBeVisible();
    // 기본 선택은 "원결제와 같은 수단"
    await expect(dialog.locator('select[name="refundMethod"]')).toHaveValue("ORIGINAL");
    await dialog.locator('textarea[name="reason"]').fill("U-4 전액 PG 외 환불");
    await dialog.getByRole("button", { name: "원장 반영" }).click();

    const okPopup = resultDialog(page, true);
    await expect(okPopup).toBeVisible({ timeout: 30_000 });
    await expect(okPopup).toContainText("PG 외 환불을 원장에 반영했습니다.");
    // 환불 가능액이 0이 되어 패널이 비어도 팝업은 남는다 — 배경·ESC로도 안 닫히고 확인으로만 닫힌다.
    await page.mouse.click(2, 2);
    await page.keyboard.press("Escape");
    await expect(okPopup).toBeVisible();
    await okPopup.getByRole("button", { name: "확인" }).click();
    await expect(okPopup).toHaveCount(0);

    const done = await waitOrderPaymentStatus(orderId, "REFUNDED", 60_000);
    expect(done.refunded_amount).toBe(price);
    const events = await refundedMethod();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: "MANUAL", payment_method: before?.payment_method });
  });

  test("환불 수단을 계좌이체로 고르면 원장에 BANK_TRANSFER로 남는다", async ({ page }) => {
    await page.getByRole("button", { name: "PG 외 환불 반영" }).click();
    const dialog = manualDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.locator('select[name="refundMethod"]').selectOption("BANK_TRANSFER");
    await dialog.locator('textarea[name="reason"]').fill("R-4 계좌이체로 환불");
    await dialog.getByRole("button", { name: "원장 반영" }).click();
    const okPopup = resultDialog(page, true);
    await expect(okPopup).toBeVisible({ timeout: 30_000 });
    await okPopup.getByRole("button", { name: "확인" }).click();

    await waitOrderPaymentStatus(orderId, "REFUNDED", 60_000);
    const events = await refundedMethod();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: "MANUAL", payment_method: "BANK_TRANSFER" });
  });

  // R-5(2026-10-02): 환불 가능액보다 큰 금액은 명령 본문(runCommand 안 — 당시 이름 runAdminCommand)에서 거절된다 — 이때 FAILED 감사 행에도
  // 대상 주문 id(target_id)가 남아야 한다(예전에는 비어 있었다).
  test("환불 거절(금액 초과)의 FAILED 감사 행에도 대상 주문 id가 남는다", async ({ page }) => {
    await openRefundModal(page);
    const dialog = refundDialog(page);
    await dialog.getByRole("radio", { name: "부분" }).click();
    await dialog.locator('input[name="partialAmount"]').evaluate((el) => {
      (el as HTMLInputElement).removeAttribute("max"); // 브라우저 검증을 넘겨 서버가 거절하게 한다
    });
    await dialog.locator('input[name="partialAmount"]').fill(String(price * 10));
    await dialog.locator('textarea[name="reason"]').fill("R-5 금액 초과");
    await dialog.getByRole("button", { name: "환불 요청 확정" }).click();

    const failPopup = resultDialog(page, false);
    await expect(failPopup).toBeVisible({ timeout: 30_000 });
    await expect(failPopup).toContainText("환불 가능액");
    await failPopup.getByRole("button", { name: "확인" }).click();

    const failedRows = async () => {
      const { data } = await admin
        .from("audit_logs")
        .select("phase, target_id")
        .eq("action", "PAYMENT_REFUND_REQUEST")
        .eq("phase", "FAILED")
        .eq("target_id", orderId);
      return data ?? [];
    };
    await expect.poll(async () => (await failedRows()).length, { timeout: 30_000 }).toBe(1);
  });

  test("실패(부분 환불 금액 누락)해도 입력 모달이 닫히고 실패 팝업이 이유를 알려 준다", async ({ page }) => {
    await openRefundModal(page);
    const dialog = refundDialog(page);
    await dialog.getByRole("radio", { name: "부분" }).click();
    // 금액을 비워 둔 채 제출 — 금액칸에 required가 없어 서버(requestOrderRefund)가 거부한다.
    await dialog.locator('textarea[name="reason"]').fill("실패 팝업 확인");
    await dialog.getByRole("button", { name: "환불 요청 확정" }).click();

    const failPopup = resultDialog(page, false);
    await expect(failPopup).toBeVisible({ timeout: 30_000 });
    await expect(failPopup).toContainText("부분 환불 금액을 양의 정수(원)로 입력해 주세요.");
    await expect(refundDialog(page)).toBeHidden(); // 닫힌 <dialog>는 DOM에 남아 있으므로 개수가 아니라 보이는지로 본다
    await failPopup.getByRole("button", { name: "확인" }).click();
    await expect(failPopup).toHaveCount(0);

    // 아무 환불도 일어나지 않았다.
    const { data } = await admin.from("orders").select("payment_status, refunded_amount").eq("id", orderId).single();
    expect(data?.payment_status).toBe("PAID");
    expect(data?.refunded_amount ?? 0).toBe(0);
  });
});
