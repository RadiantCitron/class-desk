import type {
  PaymentProvider,
  CheckoutRequest,
  CheckoutResult,
  ReturnQuery,
  CompleteReturnResult,
  ParsedWebhookEvent,
  CancelPaymentInput,
  CancelPaymentResult,
} from "./types";
import { PaymentCancelUnknownError, PaymentConfirmUnknownError } from "./types";

// 토스페이먼츠 어댑터. HTTP는 TOSS_API_BASE_URL(가짜 PG 또는 공식)로만.
// 결제창은 결제 페이지의 브라우저 SDK(V2 widgets)가 연다 — 서버 createCheckout은 SDK에 넘길 값만 만든다(토스 호출 없음).

type TossCancel = {
  cancelAmount?: number;
  transactionKey?: string;
  cancelReason?: string;
};

type TossPaymentData = {
  paymentKey?: string;
  orderId?: string | null;
  status?: string;
  totalAmount?: number;
  method?: string;
  lastTransactionKey?: string;
  approvedAt?: string;
  cancels?: TossCancel[] | null;
};

type TossWebhookBody = {
  eventType?: string;
  data?: TossPaymentData;
};

type TossErrorBody = {
  code?: string;
  message?: string;
};

function krw(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field}는 0 이상의 정수 원 금액이어야 합니다.`);
  }
  return value;
}

/** 토스 결제 1건(paymentKey)의 성공 사실 키 — 모든 경로 공통(P-1). */
export function tossPaidEventId(paymentKey: string): string {
  return `toss-paid:${paymentKey}`;
}

function paymentMethod(value: string | undefined): string {
  if (value === "카드" || value === "CARD") return "CARD";
  if (value === "계좌이체") return "BANK_TRANSFER";
  return "OTHER";
}

function ourOrderIdFromTossOrderId(tossOrderId: string | null | undefined): string | null {
  if (!tossOrderId) return null;
  const m = tossOrderId.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/i);
  return m?.[1] ?? null;
}

/** 토스 주문번호 = `{주문 UUID}_{시도 앞 8자리}` — 시도마다 달라 재결제 시 중복이 없다. 형식의 유일한 정의. */
export function tossOrderIdFor(orderId: string, attemptId: string): string {
  return `${orderId}_${attemptId.slice(0, 8)}`;
}

// 토스 주문번호 `{주문 UUID}_{시도 앞 8자리}`에서 시도 부분(createCheckout이 만든 형식).
function attemptRefFromTossOrderId(tossOrderId: string | null | undefined): string | null {
  if (!tossOrderId) return null;
  const m = tossOrderId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_([0-9a-f]{8})$/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function apiBaseUrl(): string {
  const base = process.env.TOSS_API_BASE_URL?.replace(/\/$/, "") || "https://api.tosspayments.com";
  if (process.env.NODE_ENV === "production") {
    try {
      const u = new URL(base);
      const host = u.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host === "::1" ||
        host === "[::1]" ||
        host === "host.docker.internal" ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      ) {
        throw new Error("운영 환경에서 TOSS_API_BASE_URL이 localhost/사설망입니다.");
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("운영 환경")) throw err;
      if (/localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal/i.test(base)) {
        throw new Error("운영 환경에서 TOSS_API_BASE_URL이 localhost/사설망입니다.");
      }
    }
  }
  return base;
}

/**
 * 비프로덕션: `test_` 접두사만 허용(샌드박스·fake-pg). 운영: `test_` 금지.
 * (파이널 F3 — `` 대원칙·)
 */
export function assertTossSecretKey(key: string, nodeEnv: string | undefined = process.env.NODE_ENV): string {
  if (!key) throw new Error("TOSS_SECRET_KEY가 설정되지 않았습니다.");
  const isProd = nodeEnv === "production";
  if (!isProd && !key.startsWith("test_")) {
    throw new Error(
      "비프로덕션에서는 TOSS_SECRET_KEY가 test_로 시작해야 합니다(라이브 키 금지).",
    );
  }
  if (isProd && key.startsWith("test_")) {
    throw new Error("운영 환경에서 토스 테스트 키(test_)는 사용할 수 없습니다.");
  }
  return key;
}

function secretKey(): string {
  return assertTossSecretKey(process.env.TOSS_SECRET_KEY ?? "");
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${secretKey()}:`).toString("base64")}`;
}

async function tossFetch(
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {},
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", authHeader());
  headers.set("Content-Type", "application/json");
  if (init.idempotencyKey) {
    headers.set("Idempotency-Key", init.idempotencyKey);
  }
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

/** 재시도 가능 웹훅 오류 — 라우트가 DLQ 적재 후에도 5xx를 준다. */
export class TossRetryableWebhookError extends Error {
  readonly retryable = true as const;
  constructor(message: string) {
    super(message);
    this.name = "TossRetryableWebhookError";
  }
}

function cancelTimeoutMs(): number {
  const raw = process.env.PG_CANCEL_TIMEOUT_MS;
  if (raw == null || raw === "") return 15_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
}

/**
 * 토스 취소 API 요청 본문 빌더(단위 테스트·어댑터 공용).
 * Code-B부터 cancelPayment가 이 본문으로 fetch한다(refundableAmount·Idempotency-Key 포함).
 */
export function buildTossCancelRequest(input: {
  paymentKey: string;
  cancelAmount: number;
  cancelReason: string;
  refundableAmount: number;
}) {
  krw(input.cancelAmount, "cancelAmount");
  krw(input.refundableAmount, "refundableAmount");
  if (!input.cancelReason) throw new Error("토스 취소 사유가 없습니다.");
  const reason =
    input.cancelReason.length > 200 ? input.cancelReason.slice(0, 200) : input.cancelReason;
  return {
    method: "POST" as const,
    path: `/v1/payments/${input.paymentKey}/cancel`,
    body: {
      cancelReason: reason,
      cancelAmount: input.cancelAmount,
      refundableAmount: input.refundableAmount,
    },
  };
}

/** Code-B 작업 2 토스 REJECTED 허용목록(그 밖·5xx·타임아웃 = 불명). */
const TOSS_REJECTED_ALREADY = new Set(["ALREADY_CANCELED_PAYMENT", "ALREADY_REFUND_PAYMENT"]);
const TOSS_REJECTED_400 = new Set([
  "ALREADY_CANCELED_PAYMENT",
  "ALREADY_REFUND_PAYMENT",
  "INVALID_REFUND_ACCOUNT_INFO",
  "INVALID_REFUND_ACCOUNT_NUMBER",
  "INVALID_BANK",
  "EXCEED_CANCEL_AMOUNT_DISCOUNT_AMOUNT",
  "INVALID_REQUEST",
  "NOT_MATCHES_REFUNDABLE_AMOUNT",
  "REFUND_REJECTED",
  "FORBIDDEN_BANK_REFUND_REQUEST",
  "INVALID_IDEMPOTENCY_KEY",
]);
const TOSS_REJECTED_401 = new Set(["UNAUTHORIZED_KEY"]);
const TOSS_REJECTED_403 = new Set([
  "NOT_CANCELABLE_AMOUNT",
  "NOT_CANCELABLE_PAYMENT",
  "FORBIDDEN_REQUEST",
  "EXCEED_MAX_REFUND_DUE",
  "NOT_ALLOWED_PARTIAL_REFUND_WAITING_DEPOSIT",
  "NOT_ALLOWED_PARTIAL_REFUND",
  "NOT_AVAILABLE_BANK",
  "INCORRECT_BASIC_AUTH_FORMAT",
  "NOT_CANCELABLE_PAYMENT_FOR_DORMANT_USER",
  "EXCEED_CANCEL_LIMIT",
]);
const TOSS_REJECTED_404 = new Set(["NOT_FOUND_PAYMENT"]);

export function classifyTossCancelResponse(
  status: number,
  body: { code?: string; message?: string } | null,
): CancelPaymentResult | "UNKNOWN" {
  if (status >= 200 && status < 300) {
    return { kind: "ACCEPTED" };
  }
  const code = body?.code ?? "";
  const message = body?.message ?? `HTTP ${status}`;
  if (status === 400 && TOSS_REJECTED_400.has(code)) {
    return {
      kind: "REJECTED",
      code,
      message,
      alreadyCanceled: TOSS_REJECTED_ALREADY.has(code),
    };
  }
  if (status === 401 && TOSS_REJECTED_401.has(code)) {
    return { kind: "REJECTED", code, message, alreadyCanceled: false };
  }
  if (status === 403 && TOSS_REJECTED_403.has(code)) {
    return { kind: "REJECTED", code, message, alreadyCanceled: false };
  }
  if (status === 404 && TOSS_REJECTED_404.has(code)) {
    return { kind: "REJECTED", code, message, alreadyCanceled: false };
  }
  return "UNKNOWN";
}

async function cancelPaymentToss(input: CancelPaymentInput): Promise<CancelPaymentResult> {
  const built = buildTossCancelRequest({
    paymentKey: input.providerTransactionId,
    cancelAmount: input.amount,
    cancelReason: input.reason,
    refundableAmount: input.refundableAmount,
  });
  let res: { ok: boolean; status: number; json: unknown };
  try {
    res = await tossFetch(built.path, {
      method: "POST",
      body: JSON.stringify(built.body),
      idempotencyKey: input.idempotencyKey,
      signal: AbortSignal.timeout(cancelTimeoutMs()),
    });
  } catch (err) {
    throw new PaymentCancelUnknownError(
      `토스 취소 네트워크/타임아웃: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const errBody =
    res.json && typeof res.json === "object" ? (res.json as TossErrorBody) : null;
  const classified = classifyTossCancelResponse(res.status, errBody);
  if (classified === "UNKNOWN") {
    throw new PaymentCancelUnknownError(
      `토스 취소 결과 불명: HTTP ${res.status} code=${errBody?.code ?? "(없음)"}`,
    );
  }
  return classified;
}

function failedEvent(
  raw: unknown,
  amount: number,
  orderId: string | null,
  stableId?: string,
): ParsedWebhookEvent {
  return {
    eventType: "PAYMENT_FAILED",
    providerEventId: stableId ?? `fail:${orderId ?? "none"}:${String(JSON.stringify(raw)).slice(0, 64)}`,
    providerTransactionId: "unknown",
    amount,
    currency: "KRW",
    orderId,
    paymentMethod: null,
    raw,
  };
}

function succeededFromPayment(data: TossPaymentData, raw: unknown): ParsedWebhookEvent {
  if (!data.paymentKey) {
    throw new Error("토스 결제에 paymentKey가 없습니다.");
  }
  return {
    eventType: "PAYMENT_SUCCEEDED",
    providerEventId: tossPaidEventId(data.paymentKey),
    providerTransactionId: data.paymentKey,
    amount: krw(data.totalAmount, "totalAmount"),
    currency: "KRW",
    orderId: data.orderId ?? null,
    paymentMethod: paymentMethod(data.method),
    raw,
  };
}

function refundedFromCancel(
  data: TossPaymentData,
  cancel: TossCancel,
  raw: unknown,
): ParsedWebhookEvent {
  if (!data.paymentKey || !cancel.transactionKey) {
    throw new Error("토스 취소 건에 paymentKey/transactionKey가 없습니다.");
  }
  return {
    eventType: "REFUNDED",
    providerEventId: cancel.transactionKey,
    providerTransactionId: data.paymentKey,
    amount: krw(cancel.cancelAmount, "cancelAmount"),
    currency: "KRW",
    orderId: data.orderId ?? null,
    paymentMethod: paymentMethod(data.method),
    raw,
  };
}

/** 픽스처·단위 테스트용. 웹훅 바디만으로 1건 파싱(실경로는 receiveWebhook 재조회). */
export function parseTossWebhookFixture(rawBody: string): ParsedWebhookEvent {
  const body = JSON.parse(rawBody) as TossWebhookBody;
  if (body.eventType !== "PAYMENT_STATUS_CHANGED") {
    throw new Error(`토스 이벤트 ${body.eventType ?? "(없음)"}는 원장에 기록하지 않습니다.`);
  }
  const data = body.data;
  if (!data?.status || !data.paymentKey || !data.lastTransactionKey) {
    throw new Error("토스 웹훅에 status, paymentKey, lastTransactionKey가 없습니다.");
  }

  switch (data.status) {
    case "DONE":
      return succeededFromPayment(data, body);
    case "ABORTED":
    case "EXPIRED":
      return {
        eventType: "PAYMENT_FAILED",
        providerEventId: data.lastTransactionKey,
        providerTransactionId: data.paymentKey,
        amount: krw(data.totalAmount, "totalAmount"),
        currency: "KRW",
        orderId: data.orderId ?? null,
        paymentMethod: paymentMethod(data.method),
        raw: body,
      };
    case "PARTIAL_CANCELED":
    case "CANCELED": {
      const cancels = data.cancels ?? [];
      const match = cancels.find((item) => item.transactionKey === data.lastTransactionKey);
      if (!match) {
        throw new Error("토스 취소 건에서 lastTransactionKey와 맞는 cancelAmount가 없습니다.");
      }
      return refundedFromCancel(data, match, body);
    }
    case "WAITING_FOR_DEPOSIT":
      throw new Error("Q-PAY-3: 가상계좌 입금 대기는 원장 이벤트로 남기지 않습니다.");
    default:
      throw new Error(`토스 상태 ${data.status}는 원장에 기록하지 않습니다.`);
  }
}

async function fetchPayment(paymentKey: string): Promise<TossPaymentData> {
  let res: { ok: boolean; status: number; json: unknown };
  try {
    res = await tossFetch(`/v1/payments/${encodeURIComponent(paymentKey)}`, {
      method: "GET",
    });
  } catch (err) {
    throw new TossRetryableWebhookError(
      `토스 결제 조회 네트워크 실패: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status >= 500 || res.status === 0) {
    throw new TossRetryableWebhookError(`토스 결제 조회 실패: ${res.status}`);
  }
  if (!res.ok || !res.json || typeof res.json !== "object") {
    throw new Error(`토스 결제 조회 실패: ${res.status}`);
  }
  return res.json as TossPaymentData;
}

function eventsFromPaymentSnapshot(data: TossPaymentData, raw: unknown): ParsedWebhookEvent[] {
  if (data.status === "WAITING_FOR_DEPOSIT") {
    return [];
  }
  const ledgerOrderId = ourOrderIdFromTossOrderId(data.orderId);
  const cancels = data.cancels ?? [];

  // F-11: 환불이 먼저 반영된 스냅샷에도 성공 사실을 paymentKey 고정 키로 남긴다.
  if (cancels.length > 0 && data.paymentKey) {
    const events: ParsedWebhookEvent[] = [
      {
        eventType: "PAYMENT_SUCCEEDED",
        providerEventId: tossPaidEventId(data.paymentKey),
        providerTransactionId: data.paymentKey,
        amount: krw(data.totalAmount ?? 0, "totalAmount"),
        currency: "KRW",
        orderId: ledgerOrderId,
        paymentMethod: paymentMethod(data.method),
        raw,
      },
    ];
    for (const c of cancels) {
      const ev = refundedFromCancel(data, c, raw);
      ev.orderId = ledgerOrderId;
      events.push(ev);
    }
    return events;
  }

  if (data.status === "DONE") {
    const ev = succeededFromPayment(data, raw);
    ev.orderId = ledgerOrderId;
    return [ev];
  }
  if (data.status === "ABORTED" || data.status === "EXPIRED") {
    return [
      {
        eventType: "PAYMENT_FAILED",
        providerEventId: data.lastTransactionKey ?? `fail:${data.paymentKey ?? "unknown"}`,
        providerTransactionId: data.paymentKey ?? "unknown",
        amount: krw(data.totalAmount ?? 0, "totalAmount"),
        currency: "KRW",
        orderId: ledgerOrderId,
        paymentMethod: paymentMethod(data.method),
        raw,
      },
    ];
  }
  return [];
}

// 승인(confirm) 실패 응답 중 "PG가 처리했는지 모르는" 것(docs/결제/토스페이먼츠-API기록.md 7-1·7-3, 공식 /reference/error-codes 요약).
// 5xx 전부와 이 코드들은 확정 거절이 아니다 — 재조회로 결과를 확정하지 못하면 실패로 기록하지 않고 불명으로 던진다.
// ALREADY_PROCESSED_PAYMENT는 "이미 처리됨"(성공했을 수 있음)이라 특히 실패로 쓰면 안 된다.
const TOSS_CONFIRM_UNCERTAIN_CODES = new Set([
  "PROVIDER_ERROR",
  "ALREADY_PROCESSING_REQUEST",
  "ALREADY_PROCESSED_PAYMENT",
]);

/** 승인 실패 응답이 확정 거절인가(4xx이고 처리 여부 불확실 코드가 아님). 아니면 재조회로 확정 못 할 때 결과 불명이다. */
export function isDefiniteConfirmRejection(status: number, code: string | undefined): boolean {
  return status >= 400 && status < 500 && !TOSS_CONFIRM_UNCERTAIN_CODES.has(code ?? "");
}

// 사용자가 결제 과정을 직접 중단했을 때 토스가 failUrl에 붙이는 코드 — 실패가 아니라 취소라 원장에 남기지 않는다.
const USER_CANCEL_CODES = new Set(["PAY_PROCESS_CANCELED", "USER_CANCEL"]);

export const tossProvider: PaymentProvider = {
  name: "TOSS",

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const tossOrderId = tossOrderIdFor(req.orderId, req.attemptId);
    // 결제창은 결제 페이지의 브라우저 SDK가 연다 — 서버는 SDK에 넘길 값만 만든다(토스 호출 없음).
    return {
      checkoutUrl: null,
      clientParams: {
        tossOrderId,
        amount: String(req.amount),
        orderName: req.orderName,
        customerName: req.buyerName ?? "",
        successUrl: req.returnUrl,
        failUrl: req.returnUrl,
      },
    };
  },

  async completeReturn(
    query: ReturnQuery,
    expectedAmount: number,
    expectedOrderId: string,
  ): Promise<CompleteReturnResult> {
    // 토스 위젯 orderId는 `${orders.id}_${attemptId[:8]}`. 원장 FK는 라우트 UUID만.
    const tossOrderId = query.orderId ?? null;
    const queryLedgerId = ourOrderIdFromTossOrderId(tossOrderId);
    if (queryLedgerId && queryLedgerId !== expectedOrderId) {
      return {
        kind: "CONFIRMED",
        event: failedEvent(
          { ...query, reason: "복귀 orderId와 경로 주문 불일치" },
          expectedAmount,
          expectedOrderId,
          `order-mismatch:${expectedOrderId}:${query.code ?? query.paymentKey ?? "x"}`,
        ),
      };
    }
    const orderId = expectedOrderId;

    if (query.code && USER_CANCEL_CODES.has(query.code)) {
      return { kind: "CANCELED" };
    }

    if (query.code) {
      return {
        kind: "CONFIRMED",
        event: failedEvent(
          { ...query },
          expectedAmount,
          orderId,
          // attempt를 키에 포함한다 — 같은 주문에서 같은 코드(예: 카드사 거절)가 시도마다 반복돼도 매번 기록돼야 한다(2026-10-02).
          `fail-code:${orderId}:${query.attempt ?? ""}:${query.code}:${query.paymentKey ?? ""}`,
        ),
      };
    }

    const paymentKey = query.paymentKey;
    const amountRaw = query.amount;
    if (!paymentKey || amountRaw == null) {
      return {
        kind: "CONFIRMED",
        event: failedEvent(
          { ...query, reason: "paymentKey/amount 없음" },
          expectedAmount,
          orderId,
          `fail-missing:${orderId}:${paymentKey ?? ""}`,
        ),
      };
    }

    const amount = Number(amountRaw);
    if (!Number.isInteger(amount) || amount !== expectedAmount) {
      return {
        kind: "CONFIRMED",
        event: failedEvent(
          { ...query, reason: "amount 위변조 의심" },
          expectedAmount,
          orderId,
          `fail-amount:${orderId}:${paymentKey}`,
        ),
      };
    }

    const confirmRes = await tossFetch("/v1/payments/confirm", {
      method: "POST",
      idempotencyKey: paymentKey,
      body: JSON.stringify({
        paymentKey,
        orderId: tossOrderId,
        amount,
      }),
    });

    if (confirmRes.ok && confirmRes.json && typeof confirmRes.json === "object") {
      const data = confirmRes.json as TossPaymentData;
      // F-3: 2xx여도 DONE만 성공. WAITING_FOR_DEPOSIT 등은 이벤트 없이 PENDING과 동일 취급.
      if (data.status !== "DONE") {
        return { kind: "AWAIT_WEBHOOK" };
      }
      const event = succeededFromPayment(data, confirmRes.json);
      event.orderId = orderId;
      return { kind: "CONFIRMED", event };
    }

    const err = (confirmRes.json ?? {}) as TossErrorBody;
    // confirm 실패를 즉시 실패로 단정하지 않고 재조회(LLM Quick Ref / PG-0) — 토스의 결제 상태가 정본이다.
    // PARTIAL_CANCELED/CANCELED는 가짜 FAILED를 만들지 않는다.
    let snappedStatus: string | undefined;
    try {
      const snapped = await fetchPayment(paymentKey);
      snappedStatus = snapped.status;
      if (snapped.status === "DONE") {
        const event = succeededFromPayment(snapped, snapped);
        event.orderId = orderId;
        return { kind: "CONFIRMED", event };
      }
      if (
        snapped.status === "PARTIAL_CANCELED" ||
        snapped.status === "CANCELED" ||
        snapped.status === "WAITING_FOR_DEPOSIT"
      ) {
        return { kind: "AWAIT_WEBHOOK" };
      }
    } catch {
      // 재조회 실패 — 아래에서 승인 응답만으로 판단한다.
    }

    // 토스가 승인 실패·만료로 확정했거나(ABORTED·EXPIRED) 승인 응답이 확정 거절이면 실패로 기록한다.
    // 그 밖(5xx·처리 여부 불확실 코드인데 재조회로도 확정 못 함)은 결과 불명 — 원장에 쓰지 않고 던진다.
    const tossSaysFailed = snappedStatus === "ABORTED" || snappedStatus === "EXPIRED";
    if (!tossSaysFailed && !isDefiniteConfirmRejection(confirmRes.status, err.code)) {
      throw new PaymentConfirmUnknownError(
        `토스 승인 결과 불명: HTTP ${confirmRes.status} code=${err.code ?? "(없음)"} 재조회 상태=${snappedStatus ?? "(조회 실패)"}`,
      );
    }

    return {
      kind: "CONFIRMED",
      event: failedEvent(
        { confirm: confirmRes.json, code: err.code, message: err.message },
        expectedAmount,
        orderId,
        `fail-confirm:${orderId}:${paymentKey}`,
      ),
    };
  },

  async receiveWebhook(rawBody: string, _headers: Headers): Promise<ParsedWebhookEvent[]> {
    let body: TossWebhookBody;
    try {
      body = JSON.parse(rawBody) as TossWebhookBody;
    } catch {
      throw new Error("토스 웹훅 JSON 파싱 실패");
    }
    if (body.eventType !== "PAYMENT_STATUS_CHANGED") {
      return [];
    }
    const paymentKey = body.data?.paymentKey;
    if (!paymentKey) {
      throw new Error("토스 웹훅에 paymentKey가 없습니다.");
    }
    // 서명 없음 — 웹훅은 트리거만, 사실은 재조회.
    const snapped = await fetchPayment(paymentKey);
    const attemptRef = attemptRefFromTossOrderId(snapped.orderId);
    return eventsFromPaymentSnapshot(snapped, { webhook: body, payment: snapped }).map((e) => ({ ...e, attemptRef }));
  },

  webhookAck() {
    return { status: 200, body: JSON.stringify({ ok: true }) };
  },

  cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentResult> {
    return cancelPaymentToss(input);
  },
};
