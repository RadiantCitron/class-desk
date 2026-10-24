// 결제 파사드 — 이 파일이 유일한 공개 입구다(2026-09-23 확정). Supabase의 자체
// 외부 PG 어댑터가 여러 결제 수단을 단일 호출 뒤로 숨기듯, 결제도
// "PG가 뭐든, 확인이 자동이든 수동이든" 두 함수 뒤로 숨긴다.
//
// app/** 은 lib/payment/providers를 직접 참조하지 않는다(결제 자격검증은 에서
// lib/guards/checkout으로 옮겨 CS 가드가 됐다)
// (guard test: lib/payment/facade-boundary.guard.test.ts).
// 웹훅 라우트는 ingestWebhook으로만 들어온다(F단계).
import { PAYMENT_ORDER_NAME } from "./order-name";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getPaymentProvider,
  resolveProvider,
  urlSegmentForProvider,
  type ProviderName,
  type ReturnQuery,
} from "@/lib/payment/providers";
import { TossRetryableWebhookError } from "@/lib/payment/providers/toss";
import { UserFacingError } from "@/lib/errors";
import { isRefundRequestClosed, latestRefundRequest } from "./ledger-view";

export type StartCheckoutInput = {
  orderId: string;
  // 아래 둘은 결제 시작 가드(lib/guards/checkout의 assertCheckoutEligible)를 통과한 컨텍스트에서
  // 온다 — 결제 모듈은 주문·회원 테이블을 직접 읽지 않는다.
  // (actorProfileId·buyerPhone·method는 쓰는 곳이 없어 이후 지웠다 — 결제수단은 PG 결제창이 고른다.)
  amount: number;
  buyerName: string | null;
};

export type ConfirmPaymentInput = {
  provider: string;
  providerEventId: string;
  providerTransactionId?: string;
  eventType: "PAYMENT_SUCCEEDED" | "PAYMENT_FAILED" | "REFUNDED";
  amount: number;
  currency: string;
  // PG가 보낸 원문(웹훅)이라 신뢰할 수 없는 입력이다 — 주문 번호가 없거나 잘못됐으면
  // record_payment_event()가 예외를 던지고, 호출부(webhook route)가 DLQ에 남긴다.
  orderId: string | null;
  paymentMethod: string | null;
  metadata?: Record<string, unknown>;
  raw: unknown;
};

function isInsecurePublicBase(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && process.env.NODE_ENV === "production") return true;
    const host = u.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "[::1]" ||
      host === "host.docker.internal" ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    );
  } catch {
    return true;
  }
}

function requireAppBaseUrl(): string {
  const base = process.env.APP_BASE_URL;
  if (!base) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "APP_BASE_URL이 설정되지 않았습니다. 결제를 진행할 수 없습니다.",
      );
    }
    // 로컬·테스트: 절대 URL이 필요해 기본 오리진을 쓴다(운영은 위에서 막음).
    return "http://127.0.0.1:3000";
  }
  const normalized = base.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production" && isInsecurePublicBase(normalized)) {
    throw new Error("운영 환경에서 APP_BASE_URL이 localhost/사설망입니다.");
  }
  return normalized;
}

// 결제 시작의 유일한 입구 — PG 웹훅이 부르든(현재 없음) 관리자가 부르든(현재 없음) 학생
// 화면(app/student/payment/[orderId]/actions.ts)이든 전부 여기로 들어간다.
// 자격검증은 호출 전에 runCommand()의 가드가 끝낸다.
export async function startCheckout(
  input: StartCheckoutInput,
): Promise<{ checkoutUrl: string | null; clientParams: Record<string, string> | null }> {
  const admin = createAdminClient();
  const attemptId = randomUUID();
  const baseUrl = requireAppBaseUrl();

  // PG(어댑터)를 먼저 부르고, 값이 나온 뒤에만 시도를 저장한다.
  // 시도(payment_attempts)는 토스 공식 흐름의 "결제 요청 전 주문번호 임시 저장"이다 —
  // 원장(payment_events)에는 쓰지 않는다. 원장에는 우리 서버의 승인 호출 결과(성공/실패)만 남는다.
  // attemptId는 createCheckout(토스 주문번호의 일부)과 payment_attempts.id에 같은 값을 쓴다.
  const provider = await getPaymentProvider();
  // webhookUrl: 결제 요청마다 웹훅 주소를 받는 PG용 골격. 토스는 쓰지 않는다(웹훅은 개발자센터에 등록).
  const webhookUrl = `${baseUrl}/api/webhooks/payment/${urlSegmentForProvider(provider.name as ProviderName)}`;
  const returnUrl = `${baseUrl}/student/payment/${input.orderId}/return?attempt=${attemptId}`;
  const { checkoutUrl, clientParams } = await provider.createCheckout({
    orderId: input.orderId,
    attemptId,
    amount: input.amount,
    currency: "KRW",
    orderName: PAYMENT_ORDER_NAME,
    buyerName: input.buyerName,
    returnUrl,
    webhookUrl,
  });

  const { error: attemptError } = await admin.from("payment_attempts").insert({
    id: attemptId,
    order_id: input.orderId,
    provider: provider.name,
  });
  if (attemptError) {
    throw new Error(`결제 시도 저장 실패: ${attemptError.message}`);
  }

  return { checkoutUrl, clientParams: clientParams ?? null };
}

// 결제 확정의 유일한 입구 — PG 웹훅이 파싱한 이벤트를 넘기든, 다음에 관리자 수동 확인
// 화면이 같은 모양으로 채워 넘기든 여기 하나로 들어간다. 실제 반영 여부(금액 대사·주문
// 상태 검증)는 record_payment_event()가 판단하고, 반영 거부 사유는 이 함수가 아니라
// dead_letters(DLQ, /admin/dlq 화면)에 남긴다 — 그래서 반환값은 "원장에 새로 기록됐나"
// (멱등성 신호)이지 "수강 상태가 실제로 바뀌었나"가 아니다.
export async function confirmPayment(input: ConfirmPaymentInput): Promise<{ recorded: boolean }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("record_payment_event", {
    p_provider: input.provider,
    p_provider_event_id: input.providerEventId,
    p_provider_transaction_id: input.providerTransactionId,
    p_event_type: input.eventType,
    p_amount: input.amount,
    p_currency: input.currency,
    p_order_id: input.orderId,
    p_payment_method: input.paymentMethod,
    p_metadata: input.metadata ?? {},
    p_raw_payload: input.raw as object,
  });

  if (error) {
    throw new Error(`결제 이벤트 기록 실패: ${error.message}`);
  }

  return { recorded: data === true };
}

export type RequestRefundInput = {
  orderId: string;
  amount: number | null;
  reason: string;
  requestKey: string;
  source: "ADMIN" | "OFFERING_CANCEL" | "AUTO";
  /** 학생의 환불 신청(주문 이벤트 REFUND_REQUESTED)에서 시작된 환불이면 그 이벤트 id — 환불 원인을 STUDENT_REFUND로 구분한다. */
  studentRequestEventId?: string | null;
  /** 일정 변경 미동의·무응답 처리에서 시작된 환불이면 그 안내 이벤트 id — 환불 원인을 SCHEDULE_CHANGE로 구분한다. */
  scheduleChangeNoticeEventId?: string | null;
  /** 이미 종결된 주문(CANCELLED)에 대한 사후 환불 여부. 참이면 결제 원장에 post_close 표지를 싣고 원인을 POST_CLOSE_REFUND로 판정한다. */
  postClose?: boolean;
  /** 환불을 실행하는 관리자 회원 ID. ADMIN / OFFERING_CANCEL 출처 시 필수. */
  actorId?: string | null;
  /** 일괄 환불 묶음 ID. 결제 원장 메타데이터에 batch_id로 기록된다. */
  batchId?: string | null;
  /** 운영 사정 환불 여부. 참이면 원인을 OPERATOR_REFUND로 판정한다. */
  operatorCause?: boolean;
  /** 수강 유지 부분 환불 (회차 취소 보상) 여부. 참이면 환불 후에도 수강과 이용권·디스코드 역할을 유지한다. */
  keepOrder?: boolean;
};

export type RequestRefundResult = {
  result: "SUBMITTED" | "ALREADY_IN_PROGRESS" | "NOTHING_TO_REFUND";
};

type BeginRefundRow = {
  outcome: string;
  request_event_id: string | null;
  provider: string | null;
  provider_transaction_id: string | null;
  refundable: number | null;
  payment_amount: number | null;
};

/** 원장 잔액(SUCCEEDED − REFUNDED). orders 미사용(D17a). */
export async function getRefundableAmount(orderId: string): Promise<number> {
  const admin = createAdminClient();
  const { data: paid } = await admin
    .from("payment_events")
    .select("amount")
    .eq("order_id", orderId)
    .eq("event_type", "PAYMENT_SUCCEEDED")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!paid) return 0;
  const { data: refunds } = await admin
    .from("payment_events")
    .select("amount")
    .eq("order_id", orderId)
    .eq("event_type", "REFUNDED");
  const sum = (refunds ?? []).reduce((s, r) => s + (r.amount ?? 0), 0);
  return Math.max(0, (paid.amount ?? 0) - sum);
}

/** ADMIN "요청 실패로 표시" — 열린 REFUND_REQUESTED만 fail. */
export async function markRefundRequestFailed(
  orderId: string,
  reason: string,
): Promise<void> {
  const admin = createAdminClient();
  // 열린 요청 판정은 화면·대사와 같은 함수(ledger-view.ts).
  const { data: events, error: readError } = await admin
    .from("payment_events")
    .select("id, event_type, created_at")
    .eq("order_id", orderId)
    .in("event_type", ["REFUND_REQUESTED", "REFUNDED", "REFUND_REQUEST_FAILED"]);
  if (readError) throw new Error(`환불 요청 조회 실패: ${readError.message}`);
  const requested = latestRefundRequest(events ?? []);
  if (!requested) {
    throw new UserFacingError("열린 환불 요청이 없습니다.");
  }
  if (isRefundRequestClosed(requested, events ?? [])) {
    throw new UserFacingError("이미 닫힌 환불 요청입니다.");
  }
  const { error } = await admin.rpc("fail_refund_request", {
    p_request_event_id: requested.id,
    p_error: reason,
    p_source: "ADMIN",
  });
  if (error) throw new Error(error.message);
}

export async function requestRefund(
  input: RequestRefundInput,
): Promise<RequestRefundResult> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("begin_refund_request", {
    p_order_id: input.orderId,
    p_request_key: input.requestKey,
    p_amount: input.amount,
    p_reason: input.reason,
    p_source: input.source,
    p_student_request_event_id: input.studentRequestEventId ?? null,
    p_schedule_change_notice_event_id: input.scheduleChangeNoticeEventId ?? null,
    p_post_close: input.postClose ?? false,
    p_actor_id: input.actorId ?? null,
    p_batch_id: input.batchId ?? null,
    p_operator_cause: input.operatorCause ?? false,
    p_keep_order: input.keepOrder ?? false,
  });
  if (error) {
    throw new UserFacingError(error.message);
  }
  const row = (Array.isArray(data) ? data[0] : data) as BeginRefundRow | null;
  if (!row) {
    throw new Error("begin_refund_request 응답이 비어 있습니다.");
  }

  if (row.outcome === "OPEN_EXISTS") {
    return { result: "ALREADY_IN_PROGRESS" };
  }
  if (row.outcome === "NOTHING_TO_REFUND" || row.outcome === "NOT_PAID") {
    return { result: "NOTHING_TO_REFUND" };
  }
  if (row.outcome === "KEY_USED") {
    throw new UserFacingError(
      "이전 요청이 이미 끝났습니다. 새로고침 후 다시 시도하세요.",
    );
  }
  if (row.outcome !== "CREATED" || !row.request_event_id) {
    throw new Error(`begin_refund_request 알 수 없는 outcome: ${row.outcome}`);
  }

  const providerName = row.provider;
  // 취소 API를 지원하는 PG만 앱 환불이 가능하다. 폐기된 과거 PG(PAYAPP 등)의 결제는 PG 외 환불 반영으로 처리한다.
  if (providerName !== "TOSS") {
    await admin.rpc("fail_refund_request", {
      p_request_event_id: row.request_event_id,
      p_error: `PG 취소를 지원하지 않는 provider: ${providerName}`,
      p_source: input.source,
    });
    throw new UserFacingError(
      "이 결제는 PG 취소 API로 환불할 수 없습니다. PG 외 환불 반영을 사용하세요.",
    );
  }

  const provider = resolveProvider(providerName);
  try {
    const cancelAmount = await getRequestAmount(admin, row.request_event_id);
    const cancelResult = await provider.cancelPayment({
      providerTransactionId: row.provider_transaction_id!,
      amount: cancelAmount,
      paymentAmount: row.payment_amount!,
      reason: input.reason,
      idempotencyKey: input.requestKey,
      refundableAmount: row.refundable!,
    });

    if (cancelResult.kind === "ACCEPTED") {
      return { result: "SUBMITTED" };
    }
    // REJECTED
    await admin.rpc("fail_refund_request", {
      p_request_event_id: row.request_event_id,
      p_error: `${cancelResult.code}: ${cancelResult.message}`,
      p_source: input.source,
    });
    throw new UserFacingError(
      `환불이 거절되었습니다(${cancelResult.code}): ${cancelResult.message}`,
    );
  } catch (err) {
    if (err instanceof UserFacingError) throw err;
    // 결과 불명 — fail_refund_request 금지
    console.error("환불 개시 결과 불명:", err);
    throw new Error(
      "환불 요청 결과를 확인하지 못했습니다 — PG 처리 여부를 확인 중입니다. 다시 누르지 마세요.",
    );
  }
}

async function getRequestAmount(
  admin: ReturnType<typeof createAdminClient>,
  requestEventId: string,
): Promise<number> {
  const { data } = await admin
    .from("payment_events")
    .select("amount")
    .eq("id", requestEventId)
    .maybeSingle();
  if (!data?.amount) throw new Error("환불 요청 금액을 찾지 못했습니다.");
  return data.amount;
}

export class PaymentWebhookError extends Error {
  readonly source: string;
  readonly payload: unknown;
  readonly retryable: boolean;
  /** 순수 인증 실패 — DLQ에 넣지 않는다. */
  readonly authFailure: boolean;

  constructor(
    source: string,
    payload: unknown,
    message: string,
    opts?: { retryable?: boolean; authFailure?: boolean },
  ) {
    super(message);
    this.source = source;
    this.payload = payload;
    this.retryable = opts?.retryable ?? false;
    this.authFailure = opts?.authFailure ?? false;
  }
}

export async function completeCheckout(
  providerName: ProviderName,
  query: ReturnQuery,
  expectedAmount: number,
  expectedOrderId: string,
  attemptId: string | null,
): Promise<{ status: "SUCCEEDED" | "FAILED" | "PENDING" | "CANCELED" }> {
  const provider = resolveProvider(providerName);
  // 우리 서버가 PG에 승인을 요청하기 직전에 시도에 표식을 남긴다 — 승인을 불렀는데 결과(원장 이벤트)가 안 남은 경우를
  // 대사 ⑦이 찾는다. 취소·실패로 돌아온 경우(paymentKey 없음)에는 승인을 부르지 않으므로 표식도 없다.
  // 처음 한 번만 기록한다 — 같은 복귀를 다시 열면 시각이 뒤로 밀려 대사 ⑦ 판정이 늦어지던 문제.
  // 표식은 어댑터의 금액·주문 대조보다 먼저 찍힌다: 대조에 걸리면 곧바로 결제 실패가 원장에 남아 대사 경고가 나지 않으므로
  // 해가 없고, 대조 뒤로 옮기려면 어댑터에 콜백을 넘겨야 해서 그대로 둔다.
  if (attemptId && query.paymentKey && !query.code) {
    const admin = createAdminClient();
    const { error } = await admin
      .from("payment_attempts")
      .update({ confirm_requested_at: new Date().toISOString() })
      .eq("id", attemptId)
      .is("confirm_requested_at", null);
    if (error) console.error("승인 요청 표식 저장 실패(대사 ⑦ 감지만 약해짐):", error.message);
  }
  const result = await provider.completeReturn(query, expectedAmount, expectedOrderId);
  if (result.kind === "AWAIT_WEBHOOK") return { status: "PENDING" };
  if (result.kind === "CANCELED") return { status: "CANCELED" };
  // 이 결과가 어느 시도의 것인지 원장에 남긴다 — 대사 ⑦·관리자 화면이 시도 단위로 판정한다(attempt-result.ts).
  const attemptRef = attemptId ?? result.event.attemptRef ?? null;
  await confirmPayment({
    provider: provider.name,
    providerEventId: result.event.providerEventId,
    providerTransactionId: result.event.providerTransactionId,
    eventType: result.event.eventType,
    amount: result.event.amount,
    currency: result.event.currency,
    orderId: expectedOrderId,
    paymentMethod: result.event.paymentMethod,
    metadata: attemptRef ? { attempt_ref: attemptRef } : undefined,
    raw: result.event.raw,
  });
  return { status: result.event.eventType === "PAYMENT_SUCCEEDED" ? "SUCCEEDED" : "FAILED" };
}

// 웹훅 수신의 유일한 입구. PG는 URL 세그먼트로 지정받고, 검증·파싱·확인은 전부 여기 있다.
export async function ingestWebhook(
  providerName: ProviderName,
  rawBody: string,
  headers: Headers,
): Promise<{
  failures: Array<{ raw: unknown; message: string }>;
  ack: { status: number; body: string };
}> {
  let provider;
  try {
    provider = resolveProvider(providerName);
  } catch (err) {
    throw new PaymentWebhookError(
      "INTERNAL",
      { rawBody },
      `결제 프로바이더를 사용할 수 없음: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let events;
  try {
    events = await provider.receiveWebhook(rawBody, headers);
  } catch (err) {
    const message = err instanceof Error ? err.message : "웹훅 수신 실패";
    // 서명 인증이 있는 PG가 "인증 실패"를 던지면 DLQ 없이 401 — 다른 PG용 골격. 토스는 서명이 없어 이 분기에 오지 않는다.
    const authFailure = /인증 실패/.test(message);
    const retryable =
      err instanceof TossRetryableWebhookError ||
      (typeof err === "object" &&
        err !== null &&
        "retryable" in err &&
        (err as { retryable?: boolean }).retryable === true);
    // PG별로 원문에 비밀이 실리는 PG가 생기면 여기서 그 PG만 마스킹한다(페이앱 폐기 전에는 PAYAPP 분기가 있었다).
    const payload = { rawBody };
    throw new PaymentWebhookError(provider.name, payload, message, {
      retryable,
      authFailure,
    });
  }

  const failures: Array<{ raw: unknown; message: string }> = [];
  for (const event of events) {
    try {
      await confirmPayment({
        provider: provider.name,
        providerEventId: event.providerEventId,
        providerTransactionId: event.providerTransactionId,
        eventType: event.eventType,
        amount: event.amount,
        currency: event.currency,
        orderId: event.orderId,
        paymentMethod: event.paymentMethod,
        metadata: event.attemptRef ? { attempt_ref: event.attemptRef } : undefined,
        raw: event.raw,
      });
    } catch (err) {
      failures.push({
        raw: event.raw,
        message: `결제 이벤트 기록 실패: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { failures, ack: provider.webhookAck() };
}

export type { ProviderName, ReturnQuery };

export { providerNameFromUrlSegment, urlSegmentForProvider } from "@/lib/payment/providers";

