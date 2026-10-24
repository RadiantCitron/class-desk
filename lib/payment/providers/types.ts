// 결제 PG를 어댑터 뒤로 감춘다. (2026-09-28) — 여러 PG 중 관리자가 하나를 고르는
// 구조(payment_settings, PG-1). 현재 구현은 토스페이먼츠뿐이다(페이앱은 2026-10-02 폐기, 골격은 유지).
export type CheckoutRequest = {
  orderId: string;
  attemptId: string; // 이번 결제 시도(=payment_attempts 행)의 고유 식별자. 토스는 이걸로
  // PG 주문번호를 매번 다르게 만든다(재결제 시 중복 방지).
  amount: number;
  currency: string;
  orderName: string;
  buyerName: string | null;
  returnUrl: string; // 절대 URL(APP_BASE_URL 기반, PG-2 작업 4)
  // 절대 URL. 요청마다 웹훅 주소를 받는 PG용 골격 — 토스는 쓰지 않는다(개발자센터에 수동 등록).
  webhookUrl: string;
};

export type CheckoutResult = {
  // 결제창 주소를 직접 주는 PG용 골격. 브라우저 SDK로 결제창을 여는 PG(토스)는 null이고 대신 clientParams로
  // SDK 호출 값을 준다. **현재 이 값을 받는 화면은 없다**(결제 페이지는 TossPayment로 clientParams만 쓴다) — 주소형 PG가
  // 생기면 결제 페이지에 그 분기를 함께 만들어야 한다.
  checkoutUrl: string | null;
  clientParams?: Record<string, string>;
};

export type ParsedWebhookEvent = {
  eventType: "PAYMENT_SUCCEEDED" | "PAYMENT_FAILED" | "REFUNDED";
  providerEventId: string;
  providerTransactionId: string;
  amount: number;
  currency: string;
  orderId: string | null;
  paymentMethod: string | null;
  raw: unknown;
  // 이 결과를 만든 우리 결제 시도(payment_attempts.id 또는 그 앞부분). PG 응답에서 알 수 있을 때만(토스는 주문번호의
  // `_` 뒤). 원장 metadata.attempt_ref로 남아 대사 ⑦·관리자 화면이 시도와 결과를 잇는다(lib/payment/attempt-result.ts).
  attemptRef?: string | null;
};

// 결제창에서 우리 successUrl/returnUrl로 복귀했을 때 파사드가 호출한다(신설).
export type ReturnQuery = Record<string, string | undefined>;

export type CompleteReturnResult =
  // 토스: 이 자리에서 confirm API를 불러 사실이 확정된다.
  | { kind: "CONFIRMED"; event: ParsedWebhookEvent }
  // 웹훅으로만 확정하는 PG: 확정은 웹훅에서 이미 끝났거나(먼저 도착) 아직 안 왔을 수 있다 —
  // 화면은 DB(payment_events/orders)를 다시 조회해 보여준다("판정은 DB로만").
  | { kind: "AWAIT_WEBHOOK" }
  // 사용자가 결제를 중단했다 — 원장에 아무것도 기록하지 않고 결제 페이지로 조용히 돌려보낸다
  // (토스 공식 가이드: 취소는 특별한 처리가 필요 없다).
  | { kind: "CANCELED" };

/** PG 취소 결과. 불명(타임아웃·5xx·표 밖 코드)은 throw — PaymentCancelUnknownError. */
export type CancelPaymentResult =
  | { kind: "ACCEPTED" }
  | { kind: "REJECTED"; code: string; message: string; alreadyCanceled: boolean };

export type CancelPaymentInput = {
  providerTransactionId: string; // 토스 paymentKey
  amount: number;
  paymentAmount: number;
  reason: string;
  idempotencyKey: string;
  /** 토스 refundableAmount — 원장 기준 취소 직전 잔액(begin_refund_request.refundable) */
  refundableAmount: number;
};

export interface PaymentProvider {
  name: string;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  // 복귀 시 호출. expectedAmount로 위·변조된 쿼리를 신뢰하지 않고 대조한다.
  // expectedOrderId는 라우트 경로의 주문 UUID(쿼리 orderId를 원장에 쓰지 않음 — F-4).
  completeReturn(
    query: ReturnQuery,
    expectedAmount: number,
    expectedOrderId: string,
  ): Promise<CompleteReturnResult>;
  // 검증+파싱을 한 번에 한다. 배열을 반환한다 — 토스 재조회 결과가 승인 1건 + 부분취소 여러
  // 건을 한 번에 담고 있을 수 있다(기존 verifyWebhook/parseWebhook 분리보다 이 편이 "재조회
  // 결과 전체를 사실 여러 개로 쪼갠다"는 요구에 맞는다).
  receiveWebhook(rawBody: string, headers: Headers): Promise<ParsedWebhookEvent[]>;
  // 웹훅 발신자에게 돌려줄 응답 본문(PG마다 계약이 다르다 — 토스는 200 응답).
  webhookAck(): { status: number; body: string };
  /** 환불 개시. 분류표 밖·네트워크 오류는 throw. */
  cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentResult>;
}

/**
 * 승인(confirm) 결과 불명 — PG가 처리했는지 모른다(5xx·처리 여부 불확실 코드이고 재조회로도 확정 못 함).
 * 원장에 실패를 쓰지 않는다: 복귀 화면은 "다시 결제하지 말라"(r=error)고 안내하고, 승인 요청 표식(confirm_requested_at)이
 * 남아 있어 대사 ⑦이 30분 뒤 관리자에게 알린다. 웹훅이 오면 실제 결과가 원장에 남는다.
 */
export class PaymentConfirmUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentConfirmUnknownError";
  }
}

/** 결과 불명 — 요청은 열린 채(REFUND_REQUEST_FAILED 금지). */
export class PaymentCancelUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentCancelUnknownError";
  }
}
