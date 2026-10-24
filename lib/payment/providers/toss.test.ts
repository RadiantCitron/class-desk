import { readFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertTossSecretKey,
  buildTossCancelRequest,
  classifyTossCancelResponse,
  parseTossWebhookFixture,
  TossRetryableWebhookError,
  tossProvider,
  isDefiniteConfirmRejection,
} from "./toss";
import { resolveProvider } from "./index";
import { PaymentCancelUnknownError, PaymentConfirmUnknownError } from "./types";
import {
  fakePgEnvOverrides,
  getFakePgOrigin,
  setTossCancelBehavior,
  startFakePg,
  stopFakePg,
} from "./fake-pg-harness";

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "lib/payment/providers/fixtures", name), "utf-8");

const ENV_KEYS = [
  "TOSS_SECRET_KEY",
  "NEXT_PUBLIC_TOSS_CLIENT_KEY",
  "TOSS_API_BASE_URL",
  "NEXT_PUBLIC_TOSS_SDK_URL",
  "PG_CANCEL_TIMEOUT_MS",
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

describe("토스 시크릿 키 가드(F3)", () => {
  it("비프로덕션에서 test_만 허용한다", () => {
    expect(assertTossSecretKey("test_sk_x", "test")).toBe("test_sk_x");
    expect(assertTossSecretKey("test_gsk_x", "development")).toBe("test_gsk_x");
    expect(() => assertTossSecretKey("live_sk_x", "test")).toThrow(/test_/);
    expect(() => assertTossSecretKey("", "test")).toThrow(/설정되지/);
  });

  it("운영에서 test_를 거부한다", () => {
    expect(assertTossSecretKey("live_sk_x", "production")).toBe("live_sk_x");
    expect(() => assertTossSecretKey("test_gsk_x", "production")).toThrow(/운영/);
  });
});

describe("토스 웹훅 파서(픽스처)", () => {
  it("DONE은 성공이고 금액은 totalAmount다", () => {
    expect(parseTossWebhookFixture(fixture("toss-done.json"))).toMatchObject({
      eventType: "PAYMENT_SUCCEEDED",
      providerEventId: "toss-paid:toss-payment-key-1",
      providerTransactionId: "toss-payment-key-1",
      amount: 50000,
      paymentMethod: "CARD",
      orderId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("부분 취소 금액은 lastTransactionKey와 맞는 cancelAmount 하나다", () => {
    const parsed = parseTossWebhookFixture(fixture("toss-partial-canceled.json"));
    expect(parsed.eventType).toBe("REFUNDED");
    expect(parsed.amount).toBe(15000);
    expect(parsed.providerEventId).toBe("toss-tx-cancel-2");
  });

  it("전액 취소도 취소 건의 cancelAmount를 쓰고 totalAmount와 별개로 읽는다", () => {
    expect(parseTossWebhookFixture(fixture("toss-canceled.json"))).toMatchObject({
      eventType: "REFUNDED",
      amount: 50000,
      providerEventId: "toss-tx-cancel-full",
    });
  });

  it("승인 실패는 PAYMENT_FAILED다", () => {
    expect(parseTossWebhookFixture(fixture("toss-aborted.json"))).toMatchObject({
      eventType: "PAYMENT_FAILED",
      amount: 50000,
    });
  });

  it("가상계좌 입금 대기는 기록하지 않는다", () => {
    expect(() => parseTossWebhookFixture(fixture("toss-waiting-for-deposit.json"))).toThrow(/Q-PAY-3/);
  });
});

describe("토스 취소 요청 본문", () => {
  it("fetch 없이 부분 취소 본문만 만든다", () => {
    expect(
      buildTossCancelRequest({
        paymentKey: "toss-payment-key-1",
        cancelAmount: 15000,
        cancelReason: "부분 환불",
        refundableAmount: 50000,
      }),
    ).toEqual({
      method: "POST",
      path: "/v1/payments/toss-payment-key-1/cancel",
      body: {
        cancelReason: "부분 환불",
        cancelAmount: 15000,
        refundableAmount: 50000,
      },
    });
  });
});

describe("토스 취소 응답 분류", () => {
  it("2xx는 ACCEPTED", () => {
    expect(classifyTossCancelResponse(200, null)).toEqual({ kind: "ACCEPTED" });
  });

  it("ALREADY_CANCELED_PAYMENT는 REJECTED alreadyCanceled", () => {
    expect(
      classifyTossCancelResponse(400, {
        code: "ALREADY_CANCELED_PAYMENT",
        message: "이미",
      }),
    ).toEqual({
      kind: "REJECTED",
      code: "ALREADY_CANCELED_PAYMENT",
      message: "이미",
      alreadyCanceled: true,
    });
  });

  it("403 NOT_CANCELABLE_PAYMENT·404 NOT_FOUND_PAYMENT는 REJECTED", () => {
    expect(
      classifyTossCancelResponse(403, { code: "NOT_CANCELABLE_PAYMENT", message: "x" }),
    ).toMatchObject({ kind: "REJECTED", code: "NOT_CANCELABLE_PAYMENT" });
    expect(
      classifyTossCancelResponse(404, { code: "NOT_FOUND_PAYMENT", message: "x" }),
    ).toMatchObject({ kind: "REJECTED", code: "NOT_FOUND_PAYMENT" });
  });

  it("PROVIDER_ERROR·FORBIDDEN_CONSECUTIVE·500·표 밖 코드는 불명", () => {
    expect(classifyTossCancelResponse(400, { code: "PROVIDER_ERROR", message: "x" })).toBe(
      "UNKNOWN",
    );
    expect(
      classifyTossCancelResponse(403, {
        code: "FORBIDDEN_CONSECUTIVE_REQUEST",
        message: "x",
      }),
    ).toBe("UNKNOWN");
    expect(
      classifyTossCancelResponse(500, { code: "FAILED_REFUND_PROCESS", message: "x" }),
    ).toBe("UNKNOWN");
    expect(classifyTossCancelResponse(400, { code: "SOME_NEW_CODE", message: "x" })).toBe(
      "UNKNOWN",
    );
  });
});

describe("결제 프로바이더 레지스트리", () => {
  it("TOSS는 토스 어댑터를 고른다", () => {
    expect(resolveProvider("TOSS").name).toBe("TOSS");
  });
});

describe("토스 승인 실패 응답 분류", () => {
  it("4xx 확정 거절은 실패로 기록해도 된다", () => {
    expect(isDefiniteConfirmRejection(403, "REJECT_CARD_PAYMENT")).toBe(true);
    expect(isDefiniteConfirmRejection(400, "INVALID_REQUEST")).toBe(true);
    expect(isDefiniteConfirmRejection(404, "NOT_FOUND_PAYMENT_SESSION")).toBe(true);
  });

  it("5xx·처리 여부 불확실 코드·이미 처리됨은 확정 거절이 아니다", () => {
    expect(isDefiniteConfirmRejection(500, "FAILED_INTERNAL_SYSTEM_PROCESSING")).toBe(false);
    expect(isDefiniteConfirmRejection(500, undefined)).toBe(false);
    expect(isDefiniteConfirmRejection(400, "PROVIDER_ERROR")).toBe(false);
    expect(isDefiniteConfirmRejection(400, "ALREADY_PROCESSING_REQUEST")).toBe(false);
    expect(isDefiniteConfirmRejection(400, "ALREADY_PROCESSED_PAYMENT")).toBe(false);
  });
});

describe("토스 어댑터 ↔ 가짜 PG 계약", () => {
  beforeAll(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    await startFakePg();
    Object.assign(process.env, fakePgEnvOverrides());
  });

  afterAll(() => {
    stopFakePg();
    for (const key of ENV_KEYS) {
      const v = savedEnv[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  });

  beforeEach(() => {
    Object.assign(process.env, fakePgEnvOverrides());
  });

  async function simulateCheckoutSuccess(input: {
    orderId: string;
    amount: number;
    successUrl: string;
  }) {
    const origin = getFakePgOrigin();
    const body = new URLSearchParams({
      orderId: input.orderId,
      amount: String(input.amount),
      successUrl: input.successUrl,
      failUrl: input.successUrl,
      webhookUrl: `${origin}/__control/toss/webhook`,
    });
    const res = await fetch(`${origin}/toss/checkout/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (!location) throw new Error("checkout/confirm Location 없음");
    const u = new URL(location);
    return {
      paymentKey: u.searchParams.get("paymentKey")!,
      orderId: u.searchParams.get("orderId")!,
      amount: u.searchParams.get("amount")!,
    };
  }

  it("createCheckout → 가짜 성공 → completeReturn이 CONFIRMED(성공)", async () => {
    const orderId = "11111111-1111-4111-8111-111111111101";
    const amount = 50000;
    const { checkoutUrl, clientParams } = await tossProvider.createCheckout({
      orderId,
      attemptId: "abcdef0123456789",
      amount,
      currency: "KRW",
      orderName: "테스트",
      buyerName: "홍길동",
      returnUrl: "http://127.0.0.1:3000/student/payment/x/return",
      webhookUrl: "http://127.0.0.1:3000/api/webhooks/payment/toss",
    });
    // 결제창은 결제 페이지의 SDK가 연다 — 서버는 이동 주소 없이 SDK 호출 값만 준다.
    expect(checkoutUrl).toBeNull();
    expect(clientParams?.tossOrderId).toContain("_");

    const q = await simulateCheckoutSuccess({
      orderId,
      amount,
      successUrl: "http://127.0.0.1:3000/student/payment/x/return",
    });
    const result = await tossProvider.completeReturn(q, amount, orderId);
    expect(result.kind).toBe("CONFIRMED");
    if (result.kind === "CONFIRMED") {
      expect(result.event.eventType).toBe("PAYMENT_SUCCEEDED");
      expect(result.event.amount).toBe(amount);
      expect(result.event.providerTransactionId).toBe(q.paymentKey);
      expect(result.event.providerEventId).toBe(`toss-paid:${q.paymentKey}`);
    }
  });

  it("매직 금액 1이면 confirm 실패 → PAYMENT_FAILED", async () => {
    const orderId = "11111111-1111-4111-8111-111111111102";
    const amount = 1;
    const q = await simulateCheckoutSuccess({
      orderId,
      amount,
      successUrl: "http://127.0.0.1:3000/r",
    });
    const result = await tossProvider.completeReturn(q, amount, orderId);
    expect(result.kind).toBe("CONFIRMED");
    if (result.kind === "CONFIRMED") {
      expect(result.event.eventType).toBe("PAYMENT_FAILED");
    }
  });

  // 승인 결과를 모르면(5xx·처리 여부 불확실, 재조회로도 확정 못 함) 실패로 기록하지 않고 불명으로 던진다.
  it("매직 금액 4(confirm 500, 재조회 READY)면 결과 불명 — PAYMENT_FAILED를 만들지 않는다", async () => {
    const orderId = "11111111-1111-4111-8111-111111111104";
    const amount = 4;
    const q = await simulateCheckoutSuccess({ orderId, amount, successUrl: "http://127.0.0.1:3000/r" });
    await expect(tossProvider.completeReturn(q, amount, orderId)).rejects.toBeInstanceOf(PaymentConfirmUnknownError);
  });

  it("매직 금액 5(confirm 500, 재조회도 500)면 결과 불명 — PAYMENT_FAILED를 만들지 않는다", async () => {
    const orderId = "11111111-1111-4111-8111-111111111105";
    const amount = 5;
    const q = await simulateCheckoutSuccess({ orderId, amount, successUrl: "http://127.0.0.1:3000/r" });
    await expect(tossProvider.completeReturn(q, amount, orderId)).rejects.toBeInstanceOf(PaymentConfirmUnknownError);
  });

  it("웹훅 이벤트에 토스 주문번호의 시도 부분(attemptRef)을 싣는다", async () => {
    const orderId = "11111111-1111-4111-8111-111111111106";
    const amount = 50000;
    const q = await simulateCheckoutSuccess({
      orderId: `${orderId}_abcdef01`,
      amount,
      successUrl: "http://127.0.0.1:3000/r",
    });
    const result = await tossProvider.completeReturn(q, amount, orderId);
    expect(result.kind).toBe("CONFIRMED");
    const events = await tossProvider.receiveWebhook(
      JSON.stringify({ eventType: "PAYMENT_STATUS_CHANGED", data: { paymentKey: q.paymentKey } }),
      new Headers(),
    );
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("PAYMENT_SUCCEEDED");
    expect(events[0].attemptRef).toBe("abcdef01");
  });

  it("중복 confirm은 재조회로 SUCCEEDED를 만든다", async () => {
    const orderId = "11111111-1111-4111-8111-111111111103";
    const amount = 30000;
    const q = await simulateCheckoutSuccess({
      orderId,
      amount,
      successUrl: "http://127.0.0.1:3000/r",
    });
    const first = await tossProvider.completeReturn(q, amount, orderId);
    expect(first.kind).toBe("CONFIRMED");
    if (first.kind === "CONFIRMED") expect(first.event.eventType).toBe("PAYMENT_SUCCEEDED");

    const second = await tossProvider.completeReturn(q, amount, orderId);
    expect(second.kind).toBe("CONFIRMED");
    if (second.kind === "CONFIRMED") {
      expect(second.event.eventType).toBe("PAYMENT_SUCCEEDED");
      expect(second.event.providerTransactionId).toBe(q.paymentKey);
      if (first.kind === "CONFIRMED") {
        expect(second.event.providerEventId).toBe(first.event.providerEventId);
      }
    }
  });

  it("부분취소 2건이면 receiveWebhook이 REFUNDED 2개를 반환한다", async () => {
    const orderId = "11111111-1111-4111-8111-111111111104";
    const amount = 40000;
    const q = await simulateCheckoutSuccess({
      orderId,
      amount,
      successUrl: "http://127.0.0.1:3000/r",
    });
    await tossProvider.completeReturn(q, amount, orderId);

    const origin = getFakePgOrigin();
    const auth = `Basic ${Buffer.from(`${process.env.TOSS_SECRET_KEY}:`).toString("base64")}`;
    for (const cancelAmount of [10000, 5000]) {
      const res = await fetch(`${origin}/toss/v1/payments/${q.paymentKey}/cancel`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ cancelAmount, cancelReason: "부분" }),
      });
      expect(res.ok).toBe(true);
    }

    const events = await tossProvider.receiveWebhook(
      JSON.stringify({
        eventType: "PAYMENT_STATUS_CHANGED",
        data: { paymentKey: q.paymentKey, status: "PARTIAL_CANCELED" },
      }),
      new Headers(),
    );
    // F-11: SUCCEEDED(paymentKey 고정 키) + REFUNDED 2
    expect(events).toHaveLength(3);
    expect(events[0]?.eventType).toBe("PAYMENT_SUCCEEDED");
    expect(events[0]?.providerEventId).toBe(`toss-paid:${q.paymentKey}`);
    expect(events.slice(1).every((e) => e.eventType === "REFUNDED")).toBe(true);
    expect(events.slice(1).map((e) => e.amount).sort((a, b) => a - b)).toEqual([5000, 10000]);
  });

  it("confirm이 WAITING_FOR_DEPOSIT이면 이벤트를 쓰지 않는다", async () => {
    const orderId = "11111111-1111-4111-8111-111111111105";
    const amount = 3;
    const q = await simulateCheckoutSuccess({
      orderId,
      amount,
      successUrl: "http://127.0.0.1:3000/r",
    });
    const result = await tossProvider.completeReturn(q, amount, orderId);
    expect(result.kind).toBe("AWAIT_WEBHOOK");
  });

  it("복귀 쿼리 orderId가 경로 주문과 다르면 경로 주문에만 FAILED", async () => {
    const expected = "11111111-1111-4111-8111-111111111106";
    const foreign = "22222222-2222-4222-8222-222222222201";
    const result = await tossProvider.completeReturn(
      {
        code: "PAY_PROCESS_CANCELED",
        message: "취소",
        orderId: `${foreign}_abcdef01`,
      },
      1000,
      expected,
    );
    expect(result.kind).toBe("CONFIRMED");
    if (result.kind === "CONFIRMED") {
      expect(result.event.orderId).toBe(expected);
      expect(result.event.eventType).toBe("PAYMENT_FAILED");
    }
  });

  it("사용자 취소 코드(PAY_PROCESS_CANCELED·USER_CANCEL)는 기록 없이 CANCELED", async () => {
    const orderId = "11111111-1111-4111-8111-111111111109";
    for (const code of ["PAY_PROCESS_CANCELED", "USER_CANCEL"]) {
      const result = await tossProvider.completeReturn(
        { code, message: "취소", orderId: `${orderId}_abcd1234` },
        1000,
        orderId,
      );
      expect(result.kind).toBe("CANCELED");
    }
  });

  it("failUrl 쿼리(code, 취소가 아닌 실패)면 confirm 없이 PAYMENT_FAILED", async () => {
    const orderId = "11111111-1111-4111-8111-111111111107";
    const result = await tossProvider.completeReturn(
      { code: "REJECT_CARD_COMPANY", message: "거절", orderId: `${orderId}_abcd1234` },
      1000,
      orderId,
    );
    expect(result.kind).toBe("CONFIRMED");
    if (result.kind === "CONFIRMED") {
      expect(result.event.eventType).toBe("PAYMENT_FAILED");
      expect(result.event.orderId).toBe(orderId);
    }
  });

  it("복귀 금액이 청구액과 다르면 confirm 없이 PAYMENT_FAILED", async () => {
    const orderId = "11111111-1111-4111-8111-111111111108";
    const q = await simulateCheckoutSuccess({
      orderId,
      amount: 5000,
      successUrl: "http://127.0.0.1:3000/r",
    });
    const result = await tossProvider.completeReturn({ ...q, amount: "100" }, 5000, orderId);
    expect(result.kind).toBe("CONFIRMED");
    if (result.kind === "CONFIRMED") {
      expect(result.event.eventType).toBe("PAYMENT_FAILED");
      expect(result.event.providerEventId.startsWith("fail-amount:")).toBe(true);
    }
    // 승인(confirm) 호출이 없었으므로 가짜 PG의 결제는 DONE이 아니다.
    const p = await getPayment(q.paymentKey);
    expect(p.status).not.toBe("DONE");
  });

  it("웹훅 재조회가 네트워크 실패면 재시도 가능 오류", async () => {
    process.env.TOSS_API_BASE_URL = "http://127.0.0.1:1/toss";
    try {
      await expect(
        tossProvider.receiveWebhook(
          JSON.stringify({ eventType: "PAYMENT_STATUS_CHANGED", data: { paymentKey: "x" } }),
          new Headers(),
        ),
      ).rejects.toBeInstanceOf(TossRetryableWebhookError);
    } finally {
      Object.assign(process.env, fakePgEnvOverrides());
    }
  });

  it("PAYMENT_STATUS_CHANGED가 아닌 웹훅은 빈 배열", async () => {
    await expect(
      tossProvider.receiveWebhook(
        JSON.stringify({ eventType: "DEPOSIT_CALLBACK", data: {} }),
        new Headers(),
      ),
    ).resolves.toEqual([]);
  });

  async function paidPaymentKey(orderId: string, amount: number) {
    const q = await simulateCheckoutSuccess({
      orderId,
      amount,
      successUrl: "http://127.0.0.1:3000/r",
    });
    await tossProvider.completeReturn(q, amount, orderId);
    return q.paymentKey;
  }

  async function getPayment(paymentKey: string) {
    const origin = getFakePgOrigin();
    const auth = `Basic ${Buffer.from(`${process.env.TOSS_SECRET_KEY}:`).toString("base64")}`;
    const res = await fetch(`${origin}/toss/v1/payments/${paymentKey}`, {
      headers: { Authorization: auth },
    });
    expect(res.ok).toBe(true);
    return res.json() as Promise<{ status?: string; cancels?: { cancelAmount: number }[] }>;
  }

  it("cancelPayment 2xx → ACCEPTED, 같은 Idempotency-Key 재호출은 취소 건 1회", async () => {
    const paymentKey = await paidPaymentKey("11111111-1111-4111-8111-111111111121", 50000);
    const input = {
      providerTransactionId: paymentKey,
      amount: 50000,
      paymentAmount: 50000,
      reason: "전액",
      idempotencyKey: "11111111-1111-4111-8111-111111111191",
      refundableAmount: 50000,
    };
    await expect(tossProvider.cancelPayment(input)).resolves.toEqual({ kind: "ACCEPTED" });
    await expect(tossProvider.cancelPayment(input)).resolves.toEqual({ kind: "ACCEPTED" });
    const p = await getPayment(paymentKey);
    expect(p.cancels ?? []).toHaveLength(1);
  });

  it("cancelPayment ALREADY_CANCELED·403·404 → REJECTED", async () => {
    const paymentKey = await paidPaymentKey("11111111-1111-4111-8111-111111111122", 40000);
    await tossProvider.cancelPayment({
      providerTransactionId: paymentKey,
      amount: 40000,
      paymentAmount: 40000,
      reason: "1",
      idempotencyKey: "11111111-1111-4111-8111-111111111192",
      refundableAmount: 40000,
    });
    const already = await tossProvider.cancelPayment({
      providerTransactionId: paymentKey,
      amount: 40000,
      paymentAmount: 40000,
      reason: "2",
      idempotencyKey: "11111111-1111-4111-8111-111111111193",
      refundableAmount: 40000,
    });
    expect(already).toMatchObject({
      kind: "REJECTED",
      code: "ALREADY_CANCELED_PAYMENT",
      alreadyCanceled: true,
    });

    const key403 = await paidPaymentKey("11111111-1111-4111-8111-111111111123", 35000);
    await setTossCancelBehavior(key403, "reject_403");
    await expect(
      tossProvider.cancelPayment({
        providerTransactionId: key403,
        amount: 35000,
        paymentAmount: 35000,
        reason: "x",
        idempotencyKey: "11111111-1111-4111-8111-111111111194",
        refundableAmount: 35000,
      }),
    ).resolves.toMatchObject({ kind: "REJECTED", code: "NOT_CANCELABLE_PAYMENT" });

    await expect(
      tossProvider.cancelPayment({
        providerTransactionId: "missing-payment-key",
        amount: 1000,
        paymentAmount: 1000,
        reason: "x",
        idempotencyKey: "11111111-1111-4111-8111-111111111195",
        refundableAmount: 1000,
      }),
    ).resolves.toMatchObject({ kind: "REJECTED", code: "NOT_FOUND_PAYMENT" });
  });

  it("refundableAmount 불일치 → REJECTED NOT_MATCHES, 취소 건 증가 없음", async () => {
    const paymentKey = await paidPaymentKey("11111111-1111-4111-8111-111111111124", 45000);
    await tossProvider.cancelPayment({
      providerTransactionId: paymentKey,
      amount: 10000,
      paymentAmount: 45000,
      reason: "부분",
      idempotencyKey: "11111111-1111-4111-8111-111111111196",
      refundableAmount: 45000,
    });
    const before = await getPayment(paymentKey);
    expect(before.cancels ?? []).toHaveLength(1);

    const rejected = await tossProvider.cancelPayment({
      providerTransactionId: paymentKey,
      amount: 10000,
      paymentAmount: 45000,
      reason: "잘못된 잔액",
      idempotencyKey: "11111111-1111-4111-8111-111111111197",
      refundableAmount: 45000, // 실제 잔액 35000
    });
    expect(rejected).toMatchObject({
      kind: "REJECTED",
      code: "NOT_MATCHES_REFUNDABLE_AMOUNT",
    });
    const after = await getPayment(paymentKey);
    expect(after.cancels ?? []).toHaveLength(1);
  });

  it("cancelPayment PROVIDER_ERROR·500·timeout_before/after → 불명 throw", async () => {
    process.env.PG_CANCEL_TIMEOUT_MS = "800";

    const keyProv = await paidPaymentKey("11111111-1111-4111-8111-111111111125", 32000);
    await setTossCancelBehavior(keyProv, "provider_error_400");
    await expect(
      tossProvider.cancelPayment({
        providerTransactionId: keyProv,
        amount: 32000,
        paymentAmount: 32000,
        reason: "x",
        idempotencyKey: "11111111-1111-4111-8111-111111111198",
        refundableAmount: 32000,
      }),
    ).rejects.toBeInstanceOf(PaymentCancelUnknownError);

    const key500 = await paidPaymentKey("11111111-1111-4111-8111-111111111126", 31000);
    await setTossCancelBehavior(key500, "server_500");
    await expect(
      tossProvider.cancelPayment({
        providerTransactionId: key500,
        amount: 31000,
        paymentAmount: 31000,
        reason: "x",
        idempotencyKey: "11111111-1111-4111-8111-111111111199",
        refundableAmount: 31000,
      }),
    ).rejects.toBeInstanceOf(PaymentCancelUnknownError);

    const keyT1 = await paidPaymentKey("11111111-1111-4111-8111-111111111127", 30000);
    await setTossCancelBehavior(keyT1, "timeout_before_apply");
    await expect(
      tossProvider.cancelPayment({
        providerTransactionId: keyT1,
        amount: 30000,
        paymentAmount: 30000,
        reason: "x",
        idempotencyKey: "11111111-1111-4111-8111-1111111111a1",
        refundableAmount: 30000,
      }),
    ).rejects.toBeInstanceOf(PaymentCancelUnknownError);
    expect((await getPayment(keyT1)).cancels ?? []).toHaveLength(0);

    const keyT2 = await paidPaymentKey("11111111-1111-4111-8111-111111111128", 29000);
    await setTossCancelBehavior(keyT2, "timeout_after_apply");
    await expect(
      tossProvider.cancelPayment({
        providerTransactionId: keyT2,
        amount: 29000,
        paymentAmount: 29000,
        reason: "x",
        idempotencyKey: "11111111-1111-4111-8111-1111111111a2",
        refundableAmount: 29000,
      }),
    ).rejects.toBeInstanceOf(PaymentCancelUnknownError);
    expect((await getPayment(keyT2)).cancels ?? []).toHaveLength(1);
  });
});
