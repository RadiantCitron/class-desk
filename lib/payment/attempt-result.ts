import { compareTimestamps } from "@/lib/shared/datetime";
import { tossOrderIdFor } from "./providers/toss";

// 결제 시도(payment_attempts) ↔ 그 시도의 결과(원장 PAYMENT_SUCCEEDED·PAYMENT_FAILED)를 잇는 규칙.
// 대사 ⑦(lib/integrity/checks.ts)과 관리자 주문 상세의 "결제 요청 이력"이 같은 규칙을 쓴다(DB 조회 없는 순수 함수).
//
// 원장 행의 metadata.attempt_ref = 그 결과를 만든 우리 시도를 가리키는 값. 복귀(승인) 경로는 시도 id 전체를, 웹훅 경로는
// PG가 돌려준 주문번호에서 읽은 시도 앞부분(토스는 `{주문}_{시도 앞 8자리}`)을 남긴다(lib/payment/index.ts).
// 예전엔 주문 단위로만 봐서, 시도 A의 승인 응답이 유실된 뒤 같은 주문의 시도 B가 성공하면 A도 "해결"로 보였다.
//
// attempt_ref가 없는 결과(이 규칙 전에 쌓인 행, 관리자 수동 확정 MANUAL 등)는 어느 시도의 것인지 모르므로 예전처럼
// "승인 요청 시각 이후에 생긴 같은 주문의 결과"면 그 시도의 결과로 본다.

export const RESULT_EVENT_TYPES = ["PAYMENT_SUCCEEDED", "PAYMENT_FAILED"] as const;

export type AttemptForMatch = { id: string; confirm_requested_at: string | null };
export type ResultEventForMatch = { event_type: string; created_at: string; metadata: unknown };

export function attemptRefOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const ref = (metadata as { attempt_ref?: unknown }).attempt_ref;
  return typeof ref === "string" && ref !== "" ? ref : null;
}

/** 이 시도의 결과(승인 요청 뒤 가장 먼저 생긴 것). 승인을 요청하지 않은 시도는 결과가 없다. 같은 주문의 이벤트만 넘긴다. */
export function resultForAttempt<E extends ResultEventForMatch>(
  attempt: AttemptForMatch,
  orderEvents: readonly E[],
): E | undefined {
  const requestedAt = attempt.confirm_requested_at;
  if (!requestedAt) return undefined;
  return orderEvents
    .filter((e) => {
      if (!(RESULT_EVENT_TYPES as readonly string[]).includes(e.event_type)) return false;
      if (compareTimestamps(e.created_at, requestedAt) < 0) return false;
      const ref = attemptRefOf(e.metadata);
      return ref === null || attempt.id.startsWith(ref);
    })
    .sort((a, b) => compareTimestamps(a.created_at, b.created_at))[0];
}

/** 관리자 화면에 보일 PG 쪽 주문번호(PG 관리화면에서 찾는 값). PG마다 형식이 다르고 모르는 PG면 null. */
export function pgOrderIdForAttempt(provider: string, orderId: string, attemptId: string): string | null {
  return provider === "TOSS" ? tossOrderIdFor(orderId, attemptId) : null;
}

/**
 * 복귀한 시도(attemptId)가 성공 원장 행의 결제 시도와 일치하는지 판정 (F-8 2-2).
 * - attemptRefOf(metadata)가 있으면 attemptId.startsWith(ref) 비교 (복귀 경로는 전체 ID, 웹훅은 앞부분)
 * - ref가 없거나 빈 값이면(수동 확정 등) 불일치(false) 처리
 */
export function isSameAttemptResult(attemptId: string, metadata: unknown): boolean {
  const ref = attemptRefOf(metadata);
  if (!ref) return false;
  return attemptId.startsWith(ref);
}
