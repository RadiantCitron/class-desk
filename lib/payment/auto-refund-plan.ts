import type { RefundProposal } from "@/lib/shared/refund-policy";

export type ShouldAutoRefundInput = {
  offeringAutoRefund: boolean;
  proposal: RefundProposal | null;
  order: {
    status: string;
    payment_status: string;
    payment_method: string | null;
  };
  offeringStatus?: string | null;
};

/**
 * A-9: 자동 환불 실행 조건 판정 순수 함수
 *
 * 다음 조건을 모두 만족할 때만 true를 반환한다:
 * 1. 개설강의의 auto_refund 가 true
 * 2. 주문이 APPROVED 이며 결제 상태가 PAID 또는 PARTIALLY_REFUNDED
 * 3. 결제 수단이 CARD
 * 4. 개설강의가 폐강 중(CANCELLING)이 아님
 * 5. 약관 기준 판정이 eligible === true 이고 환불 제안액이 양수(> 0)
 */
export function shouldAutoRefund(input: ShouldAutoRefundInput): boolean {
  if (!input.offeringAutoRefund) return false;

  if (input.offeringStatus === "CANCELLING" || input.offeringStatus === "CANCELLED") {
    return false;
  }

  if (input.order.status !== "APPROVED") {
    return false;
  }

  const isPaid =
    input.order.payment_status === "PAID" || input.order.payment_status === "PARTIALLY_REFUNDED";
  if (!isPaid) {
    return false;
  }

  if (input.order.payment_method !== "CARD") {
    return false;
  }

  if (!input.proposal || !input.proposal.eligible || input.proposal.amount <= 0) {
    return false;
  }

  return true;
}
