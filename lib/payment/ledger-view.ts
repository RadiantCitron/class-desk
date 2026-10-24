import { compareTimestamps } from "@/lib/shared/datetime";

// 결제 원장(payment_events) 행을 읽어 화면·대사가 쓰는 판정과 표시 라벨 — DB 조회 없는 순수 함수.
// 예전엔 같은 판정이 화면 3곳·파사드·대사에 따로 있었고 라벨은 이미 서로 달랐다. 한 곳에서 고치면 모두 바뀐다.
// (DB 함수 begin_refund_request 안의 같은 판정은 잠금과 한 트랜잭션이어야 해서 DB에 남는다 — 그쪽이 실제 판정, 이쪽은 표시·대사용.)

// 원장 이벤트 라벨. 학생·관리자 화면이 같은 표를 쓴다. PAYMENT_INITIATED는 2026-10-02 이전에 쌓인 행 표시용(이후 새로 안 생김).
export const PAYMENT_EVENT_LABELS: Record<string, string> = {
  PAYMENT_INITIATED: "결제 시작(이전 기록)",
  PAYMENT_SUCCEEDED: "결제 성공",
  PAYMENT_FAILED: "결제 실패",
  REFUND_REQUESTED: "환불 요청",
  REFUND_REQUEST_FAILED: "환불 요청 실패",
  REFUNDED: "환불",
};

export function paymentEventLabel(eventType: string): string {
  return PAYMENT_EVENT_LABELS[eventType] ?? eventType;
}

// 환불 요청이 이 시간 넘게 열려 있으면 관리자 화면에 "오래됨" 표시, 대사 ⑧이 경고한다(B D15).
export const STALE_OPEN_REFUND_MINUTES = 60;

type LedgerRow = { id: string; event_type: string; created_at: string };

/** 가장 최근 환불 요청(REFUND_REQUESTED). 없으면 undefined. */
export function latestRefundRequest<E extends LedgerRow>(events: readonly E[]): E | undefined {
  return events
    .filter((e) => e.event_type === "REFUND_REQUESTED")
    .sort((a, b) => compareTimestamps(b.created_at, a.created_at))[0];
}

/** 요청 뒤에 환불 완료·요청 실패가 생겼으면 닫힌 요청이다. */
export function isRefundRequestClosed(request: LedgerRow, events: readonly LedgerRow[]): boolean {
  return events.some(
    (e) =>
      (e.event_type === "REFUNDED" || e.event_type === "REFUND_REQUEST_FAILED") &&
      compareTimestamps(e.created_at, request.created_at) > 0,
  );
}

/** 열린 환불 요청 = 가장 최근 환불 요청이 아직 닫히지 않은 것(주문당 최대 1개 — begin_refund_request가 보장). */
export function findOpenRefundRequest<E extends LedgerRow>(events: readonly E[]): E | null {
  const latest = latestRefundRequest(events);
  if (!latest || isRefundRequestClosed(latest, events)) return null;
  return latest;
}

/** 원장엔 결제 성공이 있는데 주문은 아직 미결제 — on_payment_succeeded가 반영을 거부해 DLQ로 간 상태. */
export function hasUnreflectedSuccess(
  paymentStatus: string,
  events: readonly { event_type: string }[] | null | undefined,
): boolean {
  return paymentStatus === "UNPAID" && (events ?? []).some((e) => e.event_type === "PAYMENT_SUCCEEDED");
}
