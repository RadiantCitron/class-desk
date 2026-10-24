// 주문이 어떻게 끝났는지의 표시 라벨 — 저장하지 않고 사건 payload에서 파생한다(ADR-0026).
//   · 포기(행위)와 미수강(사실, 노쇼)은 다른 축이다. 환불로 끝난 신청은 「수강 포기」이고, 지난 회차 수로 「미수강」/「수강중」을 가른다
//     (지난 회차 = 취소 시점 날짜 이하의 회차, 당일 포함 — 환불 정책과 같은 기준).
//   · 수강생이 그만둔 것이 아닌 종료(폐강·외부 취소·환불 없이 종료)는 「수강 포기」라고 부르지 않는다.
//   · 해당하지 않는 CANCELLED(결제 전 신청 취소·탈퇴 등)나 CANCELLED가 아닌 주문은 null — 기존 라벨(「취소」 등)을 그대로 쓴다.
import type { OrderEventLike } from "./refund-request";

export type OrderEndFault = "STUDENT" | "OPERATOR" | "EXTERNAL";

export type OrderEndCode =
  | "ABANDON_BEFORE"
  | "ABANDON_DURING"
  | "ABANDON"
  | "OFFERING_CANCELLED"
  | "EXTERNAL_REFUND"
  | "SCHEDULE_CHANGE"
  | "OPERATOR_REFUND"
  | "CLOSED"
  | "WITHDRAWN"
  | "POST_END_REFUND";

export const ORDER_END_LABELS: Record<OrderEndCode, string> = {
  ABANDON_BEFORE: "수강 포기(미수강)",
  ABANDON_DURING: "수강 포기(수강중)",
  ABANDON: "수강 포기",
  OFFERING_CANCELLED: "폐강",
  EXTERNAL_REFUND: "외부 환불로 종료",
  SCHEDULE_CHANGE: "수강 포기(일정 변경)",
  OPERATOR_REFUND: "운영 사정으로 환불",
  CLOSED: "폐강 종료(환불 없음)",
  WITHDRAWN: "탈퇴로 종료",
  POST_END_REFUND: "종료 후 환불",
};

export const ORDER_END_FAULTS: Record<OrderEndCode, OrderEndFault> = {
  ABANDON_BEFORE: "STUDENT",
  ABANDON_DURING: "STUDENT",
  ABANDON: "STUDENT",
  OFFERING_CANCELLED: "OPERATOR",
  EXTERNAL_REFUND: "EXTERNAL",
  SCHEDULE_CHANGE: "STUDENT",
  OPERATOR_REFUND: "OPERATOR",
  CLOSED: "OPERATOR",
  WITHDRAWN: "STUDENT",
  POST_END_REFUND: "OPERATOR",
};

export function orderEndLabel(
  orderStatus: string,
  events: OrderEventLike[]
): { code: OrderEndCode; label: string; fault: OrderEndFault } | null {
  if (orderStatus !== "CANCELLED") return null;
  const latest = (type: string) => events.filter((e) => e.event_type === type).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  const closed = latest("CLOSED");
  if (closed) return { code: "CLOSED", label: ORDER_END_LABELS.CLOSED, fault: ORDER_END_FAULTS.CLOSED };

  const cancelled = latest("CANCELLED");
  const cause = cancelled?.payload?.cause;
  if (cause === "WITHDRAWN") {
    return { code: "WITHDRAWN", label: ORDER_END_LABELS.WITHDRAWN, fault: ORDER_END_FAULTS.WITHDRAWN };
  }
  if (cancelled?.payload?.offering_ended === true) {
    return { code: "POST_END_REFUND", label: ORDER_END_LABELS.POST_END_REFUND, fault: ORDER_END_FAULTS.POST_END_REFUND };
  }
  if (cause === "ADMIN_REFUND" || cause === "STUDENT_REFUND") {
    const past = cancelled?.payload?.past_sessions;
    if (typeof past !== "number") return { code: "ABANDON", label: ORDER_END_LABELS.ABANDON, fault: ORDER_END_FAULTS.ABANDON };
    const code: OrderEndCode = past === 0 ? "ABANDON_BEFORE" : "ABANDON_DURING";
    return { code, label: ORDER_END_LABELS[code], fault: ORDER_END_FAULTS[code] };
  }
  if (cause === "OFFERING_CANCELLED") return { code: "OFFERING_CANCELLED", label: ORDER_END_LABELS.OFFERING_CANCELLED, fault: ORDER_END_FAULTS.OFFERING_CANCELLED };
  if (cause === "OPERATOR_REFUND") return { code: "OPERATOR_REFUND", label: ORDER_END_LABELS.OPERATOR_REFUND, fault: ORDER_END_FAULTS.OPERATOR_REFUND };
  if (cause === "SCHEDULE_CHANGE") return { code: "SCHEDULE_CHANGE", label: ORDER_END_LABELS.SCHEDULE_CHANGE, fault: ORDER_END_FAULTS.SCHEDULE_CHANGE };
  if (cause === "EXTERNAL_REFUND") return { code: "EXTERNAL_REFUND", label: ORDER_END_LABELS.EXTERNAL_REFUND, fault: ORDER_END_FAULTS.EXTERNAL_REFUND };
  return null;
}
