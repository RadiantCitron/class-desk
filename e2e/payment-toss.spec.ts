import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "crypto";
import {
  admin,
  appBaseUrl,
  createApprovedOrder,
  createCourseOffering,
  createTestUser,
  deleteCourseOffering,
  expectNoNewDlqForOrder,
  fakePgOrigin,
  loginAs,
  payWithTossSuccess,
  startPaymentInFakeToss,
  retireTestUser,
  resetGates,
  setActivePaymentProvider,
  tossPaymentKey,
  waitOrderPaymentStatus,
  closeGate,
} from "./helpers";

async function consoleTossRefund(paymentKey: string, cancelAmount?: number) {
  const origin = fakePgOrigin();
  const res = await fetch(`${origin}/__control/toss/refund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentKey,
      cancelAmount,
      webhookUrl: `${appBaseUrl()}/api/webhooks/payment/toss`,
    }),
  });
  if (!res.ok) throw new Error(`toss refund control 실패: ${await res.text()}`);
}

test.describe("결제 (토스·가짜 PG)", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let orderId: string;
  const price = 50_000;

  test.beforeEach(async ({ page }) => {
    await resetGates();
    adminUser = await createTestUser({ role: "ADMIN", name: "관리자" });
    await setActivePaymentProvider("TOSS", adminUser.id);
    student = await createTestUser({ role: "STUDENT", name: "홍길동", phone: "010-1111-2222" });
    ({ courseId, offeringId } = await createCourseOffering({ price }));
    orderId = await createApprovedOrder(student.id, offeringId, price);
    await loginAs(page, student.email, student.password);
  });

  test.afterEach(async () => {
    if (student) await retireTestUser(student);
    if (adminUser) await retireTestUser(adminUser);
    if (offeringId && courseId) await deleteCourseOffering(offeringId, courseId);
  });

  test("1. 정상 결제 → PAID·이용권·성공 배너", async ({ page }) => {
    const since = new Date();
    await payWithTossSuccess(page, orderId);
    await expect(page.getByText("결제가 확인되었습니다.").first()).toBeVisible();
    const order = await waitOrderPaymentStatus(orderId, "PAID");
    expect(order.paid_at).not.toBeNull();
    const { data: ents } = await admin
      .from("entitlements")
      .select("type, revoked_at")
      .eq("order_id", orderId);
    expect(ents?.some((e) => e.type === "COURSE_ACCESS" && !e.revoked_at)).toBe(true);
    await expectNoNewDlqForOrder(orderId, since);
  });

  test("2-2. 결제 과정 중 취소 → 원장 기록·팝업 없이 결제 페이지로 조용히 복귀, 바로 재결제 가능", async ({ page }) => {
    await page.goto(`/student/payment/${orderId}`);
    await startPaymentInFakeToss(page);
    await page.waitForURL(/4010\/toss\/checkout|\/toss\/checkout/, { timeout: 45_000 });
    await page.getByRole("button", { name: "실패/취소" }).click(); // PAY_PROCESS_CANCELED
    await page.waitForURL(new RegExp(`/student/payment/${orderId}$`), { timeout: 60_000 });
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "결제하기", exact: true })).toBeVisible();
    const { data: events } = await admin.from("payment_events").select("id").eq("order_id", orderId);
    expect(events?.length ?? 0).toBe(0);
    const { data: order } = await admin.from("orders").select("payment_status").eq("id", orderId).single();
    expect(order?.payment_status).toBe("UNPAID");
  });

  test("2. 결제 실패(카드사 거절) → FAILED·UNPAID·재결제 가능", async ({ page }) => {
    await page.goto(`/student/payment/${orderId}`);
    await startPaymentInFakeToss(page);
    await page.waitForURL(/4010\/toss\/checkout|\/toss\/checkout/, { timeout: 45_000 });
    await page.getByRole("button", { name: "카드사 거절" }).click();
    await page.waitForURL(new RegExp(`/student/payment/${orderId}`), { timeout: 60_000 });
    // 실제 실패(토스가 failUrl에 REJECT_CARD_COMPANY를 붙여 보냄) → 실패 안내 팝업, 확인하면 한 번만 보인다.
    const popup = page.getByRole("alertdialog", { name: "✖ 실패했습니다" });
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("카드사");
    await popup.getByRole("button", { name: "확인" }).click();
    await expect(page).toHaveURL(new RegExp(`/student/payment/${orderId}$`));
    await page.reload();
    await expect(page.getByRole("alertdialog", { name: "✖ 실패했습니다" })).toHaveCount(0);

    const { data: failed } = await admin
      .from("payment_events")
      .select("id")
      .eq("order_id", orderId)
      .eq("event_type", "PAYMENT_FAILED");
    expect(failed?.length).toBeGreaterThanOrEqual(1);

    const { data: order } = await admin
      .from("orders")
      .select("payment_status")
      .eq("id", orderId)
      .single();
    expect(order?.payment_status).toBe("UNPAID");
    await expect(page.getByRole("button", { name: "결제하기" })).toBeVisible();
  });

  // 2026-10-02(요구 변경): 중간 이동 페이지를 없애고 토스 결제창을 결제 페이지 위에 직접 띄운다.
  // 결제 시작 전(토스 창의 "결제하기"를 누르기 전)에 창을 닫으면 사용자는 그대로 결제 페이지에 있고 결제 시도는 만들어지지 않는다
  // → 10분 대기도 없다. 결제 과정 중 사용자 취소는 기록·팝업 없이 결제 페이지로 조용히 돌아오고(테스트 2-2),
  // 실제 실패(카드사 거절 등)만 복귀 결과 r=failed로 실패 팝업을 띄운다(테스트 2).
  test("2-1. 결제창을 결제 시작 전에 닫으면 결제 페이지에 그대로 있고 시도가 만들어지지 않는다(반복 가능)", async ({ page }) => {
    await page.goto(`/student/payment/${orderId}`);
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: "결제하기", exact: true }).click();
      const win = page.getByRole("dialog", { name: "가짜 토스 결제창" });
      await expect(win).toBeVisible();
      await win.getByRole("button", { name: "닫기(가짜 토스)" }).click();
      await expect(win).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/student/payment/${orderId}$`));
      await expect(page.getByRole("button", { name: "결제하기", exact: true })).toBeVisible();
    }
    const { data: events } = await admin.from("payment_events").select("id").eq("order_id", orderId);
    expect(events?.length ?? 0).toBe(0); // 닫기만 했으므로 원장 기록이 없다
    const { data: attempts } = await admin.from("payment_attempts").select("id").eq("order_id", orderId);
    expect(attempts?.length ?? 0).toBe(0); // 시도도 없다(결제 버튼을 누르기 전)
    const { data: order } = await admin.from("orders").select("payment_status").eq("id", orderId).single();
    expect(order?.payment_status).toBe("UNPAID");

    // 닫은 뒤 곧바로 다시 결제할 수 있다.
    await startPaymentInFakeToss(page);
    await page.waitForURL(new RegExp("4010/toss/checkout|/toss/checkout"), { timeout: 45_000 });
  });

  test("3. 콘솔 전액환불 → REFUNDED·이용권 회수", async ({ page }) => {
    const since = new Date();
    await payWithTossSuccess(page, orderId);
    const paymentKey = await tossPaymentKey(orderId);
    await consoleTossRefund(paymentKey);
    await waitOrderPaymentStatus(orderId, "REFUNDED");
    const { data: order } = await admin
      .from("orders")
      .select("status, payment_status")
      .eq("id", orderId)
      .single();
    expect(order?.status).toBe("CANCELLED");
    const { data: ents } = await admin
      .from("entitlements")
      .select("revoked_at")
      .eq("order_id", orderId);
    expect(ents?.every((e) => e.revoked_at != null)).toBe(true);
    await expectNoNewDlqForOrder(orderId, since);
  });

  test("4. 콘솔 부분환불 → PARTIALLY_REFUNDED·신청 종료(수강 포기)·이용권 회수, 원인은 외부 취소", async ({ page }) => {
    const since = new Date();
    await payWithTossSuccess(page, orderId);
    const paymentKey = await tossPaymentKey(orderId);
    await consoleTossRefund(paymentKey, 15_000);
    const order = await waitOrderPaymentStatus(orderId, "PARTIALLY_REFUNDED");
    expect(order.refunded_amount).toBe(15_000);
    // 부분 환불도 수강 포기다 — 주문이 끝나고 이용권이 회수된다.
    const { data: after } = await admin.from("orders").select("status").eq("id", orderId).single();
    expect(after?.status).toBe("CANCELLED");
    const { data: ents } = await admin
      .from("entitlements")
      .select("revoked_at")
      .eq("order_id", orderId);
    expect(ents?.length).toBeGreaterThan(0);
    expect(ents?.every((e) => e.revoked_at != null)).toBe(true);
    // 우리 환불 요청 없이 PG(콘솔)에서 들어온 취소라 원인은 EXTERNAL_REFUND
    const { data: ev } = await admin.from("order_events").select("payload").eq("order_id", orderId).eq("event_type", "CANCELLED").single();
    expect(ev?.payload).toMatchObject({ cause: "EXTERNAL_REFUND", partial: true, refunded_total: 15_000 });
    await expectNoNewDlqForOrder(orderId, since);
  });

  test("5. 매직 금액 1 — confirm 실패(원장에 FAILED, 미결제)", async ({ page }) => {
    // 토스 매직 금액은 confirm 단계. 시도(payment_attempts)는 남는다.
    await deleteCourseOffering(offeringId, courseId);
    ({ courseId, offeringId } = await createCourseOffering({ price: 1 }));
    orderId = await createApprovedOrder(student.id, offeringId, 1);

    await page.goto(`/student/payment/${orderId}`);
    await startPaymentInFakeToss(page);
    await page.waitForURL(/4010\/toss\/checkout|\/toss\/checkout/, { timeout: 45_000 });
    await page.getByRole("button", { name: "성공" }).click();
    await page.waitForURL(new RegExp(`/student/payment/${orderId}`), { timeout: 60_000 });

    const { data: order } = await admin
      .from("orders")
      .select("payment_status")
      .eq("id", orderId)
      .single();
    expect(order?.payment_status).toBe("UNPAID");
    const { data: failed } = await admin
      .from("payment_events")
      .select("id")
      .eq("order_id", orderId)
      .eq("event_type", "PAYMENT_FAILED");
    expect((failed?.length ?? 0) >= 1).toBe(true);
  });

  test("6. 이중 confirm — SUCCEEDED 1건만", async ({ page }) => {
    await payWithTossSuccess(page, orderId);
    const paymentKey = await tossPaymentKey(orderId);
    // 같은 결제로 복귀를 한 번 더 연다 — 승인은 재조회로 성공(DONE)이 확인되고 원장은 중복 기록을 막는다.
    // 승인 성공 복귀는 수강 조회(/student?paid=1)로 간다(2026-10-02, return/route.ts) — 예전엔 결제 페이지를 기다려 실패했다.
    await page.goto(
      `/student/payment/${orderId}/return?paymentKey=${encodeURIComponent(paymentKey)}&orderId=${orderId}&amount=${price}`,
    );
    await page.waitForURL(/\/student\?paid=1/, { timeout: 30_000 });

    const { data: successes } = await admin
      .from("payment_events")
      .select("id")
      .eq("order_id", orderId)
      .eq("event_type", "PAYMENT_SUCCEEDED");
    expect(successes).toHaveLength(1);
    await waitOrderPaymentStatus(orderId, "PAID");
  });

  test("8. PG를 결제 차단(미설정)으로 바꾼 뒤에도 이전(토스) 환불 웹훅 경로는 처리된다", async ({ page }) => {
    await payWithTossSuccess(page, orderId);
    const paymentKey = await tossPaymentKey(orderId);
    await setActivePaymentProvider(null, adminUser.id, "e2e 전환(결제 차단)");
    await consoleTossRefund(paymentKey);
    await waitOrderPaymentStatus(orderId, "REFUNDED");
  });

  // PG-8: payment.spec.ts 이관(약관·이미결제·실패 후 재시도) + payment-webhook 게이트 1건.
  test("약관 재동의 후 다시 결제할 수 있다", async ({ page }) => {
    const version = `SERVICE_USE_E2E_${randomUUID().slice(0, 8)}`;
    const { error: termsError } = await admin.from("terms").insert({
      type: "SERVICE_USE",
      version,
      content: `E2E 새 서비스약관 ${randomUUID().slice(0, 8)}`,
    });
    expect(termsError).toBeNull();

    await page.goto(`/student/payment/${orderId}`);
    await expect(page.getByText("최신 약관에 동의해야 합니다.")).toBeVisible();
    await expect(page.getByRole("button", { name: "결제하기" })).toHaveCount(0);

    await page.getByRole("link", { name: "약관 다시 동의하러 가기" }).click();
    await expect(page).toHaveURL(/\/terms$/);

    for (const box of await page.locator('input[type="checkbox"]').all()) {
      await box.check();
    }
    await page.getByRole("button", { name: "동의하고 계속하기" }).click();
    await expect(page).toHaveURL(/\/student$/);

    await page.goto(`/student/payment/${orderId}`);
    await expect(page.getByRole("button", { name: "결제하기" })).toBeVisible();
  });

  test("결제 완료된 건은 재결제 버튼이 아니라 이력만 보인다", async ({ page }) => {
    await admin
      .from("orders")
      .update({ payment_status: "PAID", paid_at: new Date().toISOString(), payment_method: "CARD" })
      .eq("id", orderId);

    await page.goto(`/student/payment/${orderId}`);
    await expect(page.getByText("이미 처리된 결제 건입니다")).toBeVisible();
    await expect(page.getByRole("button", { name: "결제하기" })).toHaveCount(0);
  });

  test("결제 실패 후 바로 재시도해서 성공할 수 있다", async ({ page }) => {
    await page.goto(`/student/payment/${orderId}`);
    await startPaymentInFakeToss(page);
    await page.waitForURL(/4010\/toss\/checkout|\/toss\/checkout/, { timeout: 45_000 });
    await page.getByRole("button", { name: "카드사 거절" }).click();
    await page.waitForURL(new RegExp(`/student/payment/${orderId}`), { timeout: 60_000 });
    const popup = page.getByRole("alertdialog", { name: "✖ 실패했습니다" });
    await expect(popup).toBeVisible();
    await popup.getByRole("button", { name: "확인" }).click();
    await expect(page).toHaveURL(new RegExp(`/student/payment/${orderId}$`));
    await page.reload();
    await expect(page.getByRole("button", { name: "결제하기" })).toBeVisible();

    await payWithTossSuccess(page, orderId);
    await waitOrderPaymentStatus(orderId, "PAID");

    const { data: events } = await admin
      .from("payment_events")
      .select("event_type")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true });
    const types = events?.map((e) => e.event_type) ?? [];
    expect(types.filter((t) => t === "PAYMENT_FAILED").length).toBeGreaterThanOrEqual(1);
    expect(types.filter((t) => t === "PAYMENT_SUCCEEDED").length).toBe(1);
    const { data: attempts } = await admin.from("payment_attempts").select("id").eq("order_id", orderId);
    expect(attempts?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  // 웹훅은 어떤 봉쇄에도 막히지 않는다(출구, 레일 밖 — 사실 처리). 결제 모듈 봉쇄(MODULE PAYMENT 전원)와 시스템 전체 봉쇄(SYSTEM 전원) 둘 다 본다.
  // 웹훅 응답 직전에 아웃박스 드레인도 같이 돌므로 시스템 봉쇄 중 드레인도 이 테스트가 함께 덮는다(명령 레일 7절 5번, 2026-10-07 보강).
  // closeGate의 옛 이름 LOGIN은 SYSTEM 전원 스위치로 이관된 것이다.
  for (const gate of [
    { label: "결제 모듈(MODULE PAYMENT)", code: "PAYMENT" as const, suffix: "gatee2e1" },
    { label: "시스템 전체(SYSTEM)", code: "LOGIN" as const, suffix: "gatee2e2" },
  ]) {
  test(`결제 게이트가 봉쇄돼 있어도 토스 웹훅은 정상 기록된다(P-V3 이관) — ${gate.label}`, async ({ request }) => {
    // 명령 레일 CR-2: 결제 봉쇄 = 통제 스위치 MODULE PAYMENT(전원) / 시스템 봉쇄 = SYSTEM(전원).
    const { error: gateError } = await closeGate(gate.code, student.id, "e2e 테스트");
    expect(gateError).toBeNull();

    const tossOrderId = `${orderId}_${gate.suffix}`;
    const origin = fakePgOrigin();
    const webhookUrl = `${appBaseUrl()}/api/webhooks/payment/toss`;
    const secret = process.env.TOSS_SECRET_KEY || "test_sk_fake0000000000000000";
    const auth = `Basic ${Buffer.from(`${secret}:`).toString("base64")}`;

    const formBody = new URLSearchParams({
      orderId: tossOrderId,
      amount: String(price),
      successUrl: `${appBaseUrl()}/student/payment/${orderId}/return`,
      failUrl: `${appBaseUrl()}/student/payment/${orderId}/return`,
      webhookUrl,
    });
    const createRes = await fetch(`${origin}/toss/checkout/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      redirect: "manual",
    });
    const location = createRes.headers.get("location") || "";
    const paymentKey = new URL(location).searchParams.get("paymentKey");
    expect(paymentKey).toBeTruthy();

    const confirmRes = await fetch(`${origin}/toss/v1/payments/confirm`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ paymentKey, orderId: tossOrderId, amount: price }),
    });
    expect(confirmRes.ok).toBe(true);

    const wh = await request.post(`${origin}/__control/toss/webhook`, {
      data: { paymentKey, webhookUrl },
    });
    expect(wh.ok()).toBe(true);

    await waitOrderPaymentStatus(orderId, "PAID");
    await resetGates();
  });
  }
});
