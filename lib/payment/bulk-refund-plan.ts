// 폐강 및 일반 개설강의 선별·일괄 환불의 대상 판정 및 미리보기 순수 함수.
// 실제 환불 요청(requestRefund)과 금액 검증의 최종 판정은 DB 함수 begin_refund_request가 한다(가능액 초과·0 이하 거부).

export type BulkRefundOrder = { status: string; payment_status: string; payment_method: string | null };

export type BulkRefundTarget = { ok: true } | { ok: false; reason: string };

export function classifyBulkRefundTarget(order: BulkRefundOrder, refundable: number, amount: number | null): BulkRefundTarget {
  if (order.status !== "APPROVED" || !["PAID", "PARTIALLY_REFUNDED"].includes(order.payment_status)) {
    return {
      ok: false,
      reason: `환불할 결제가 없는 건입니다(${order.status}/${order.payment_status}). 무료(직권 부여) 건은 「환불 없이 종료」를 쓰세요.`,
    };
  }
  if (order.payment_method !== "CARD") {
    return { ok: false, reason: "카드(PG) 결제가 아니라 일괄 환불할 수 없습니다. 주문 상세에서 PG 외 환불 반영을 쓰세요." };
  }
  if (refundable <= 0) {
    return { ok: false, reason: "환불할 잔액이 없습니다." };
  }
  if (amount !== null && amount > refundable) {
    return { ok: false, reason: `입력한 금액이 환불 가능액(${refundable.toLocaleString()}원)보다 큽니다.` };
  }
  return { ok: true };
}

/** 부분 환불 금액 입력 검증: 양의 정수(원). 비어 있거나 소수·음수·0이면 이유를 돌려준다. */
export function parseBulkRefundAmount(raw: string): { ok: true; amount: number } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "부분 환불 금액을 입력해 주세요." };
  const n = Number(trimmed.replace(/,/g, ""));
  if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: "부분 환불 금액을 양의 정수(원)로 입력해 주세요." };
  return { ok: true, amount: n };
}

export const BULK_REFUND_MAX_STUDENTS = 30;

export type BulkRefundMode = "policy" | "full" | "fixed";

export type BulkRefundPreviewInputRow = {
  orderId: string;
  email: string;
  name: string | null;
  paidAmount: number;
  refundedAmount: number;
  refundableAmount: number;
  proposalAmount: number | null; // evaluateRefund 결과 제안액 (제안 불가 시 0 또는 null)
  proposalReason: string; // 근거 문장
  hasOpenRefundRequest?: boolean; // 열린 환불 요청 진행 중 여부
  order: BulkRefundOrder;
};

export type BulkRefundPreviewRow = {
  orderId: string;
  email: string;
  name: string | null;
  paidAmount: number;
  refundedAmount: number;
  refundableAmount: number;
  proposalAmount: number;
  proposalReason: string;
  defaultDecidedAmount: number;
  eligible: boolean;
  ineligibleReason: string | null;
};

export type BulkRefundPreviewSummary = {
  totalCount: number;
  eligibleCount: number;
  ineligibleCount: number;
  totalDecidedAmount: number;
  partialCount: number;
  fullCount: number;
};

export type BulkRefundPreviewResult =
  | {
      ok: true;
      batchId: string;
      mode: BulkRefundMode;
      rows: BulkRefundPreviewRow[];
      summary: BulkRefundPreviewSummary;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * 선별·일괄 환불 미리보기 계산 순수 함수.
 * 모드 3개(약관 제안 'policy', 전액 'full', 같은 금액 'fixed')에 따라 기본 결정액을 산출하고 요약을 집계한다.
 */
export function buildBulkRefundPreview(
  rows: BulkRefundPreviewInputRow[],
  mode: BulkRefundMode,
  options?: { fixedAmount?: number; batchId?: string },
): BulkRefundPreviewResult {
  if (rows.length === 0) {
    return { ok: false, error: "선택된 학생이 없습니다." };
  }
  if (rows.length > BULK_REFUND_MAX_STUDENTS) {
    return {
      ok: false,
      error: `한 번에 최대 ${BULK_REFUND_MAX_STUDENTS}명까지만 처리할 수 있습니다. 나눠서 진행해 주세요(현재 ${rows.length}명).`,
    };
  }

  const batchId = options?.batchId ?? "";

  const previewRows: BulkRefundPreviewRow[] = rows.map((r) => {
    if (r.hasOpenRefundRequest) {
      return {
        orderId: r.orderId,
        email: r.email,
        name: r.name,
        paidAmount: r.paidAmount,
        refundedAmount: r.refundedAmount,
        refundableAmount: r.refundableAmount,
        proposalAmount: r.proposalAmount ?? 0,
        proposalReason: r.proposalReason,
        defaultDecidedAmount: 0,
        eligible: false,
        ineligibleReason: "이미 환불 요청이 진행 중입니다.",
      };
    }

    const targetCheck = classifyBulkRefundTarget(r.order, r.refundableAmount, null);
    if (!targetCheck.ok) {
      return {
        orderId: r.orderId,
        email: r.email,
        name: r.name,
        paidAmount: r.paidAmount,
        refundedAmount: r.refundedAmount,
        refundableAmount: r.refundableAmount,
        proposalAmount: r.proposalAmount ?? 0,
        proposalReason: r.proposalReason,
        defaultDecidedAmount: 0,
        eligible: false,
        ineligibleReason: targetCheck.reason,
      };
    }

    let defaultAmount = 0;
    if (mode === "full") {
      defaultAmount = r.refundableAmount;
    } else if (mode === "fixed") {
      const fixed = options?.fixedAmount ?? 0;
      if (fixed <= 0 || fixed > r.refundableAmount) {
        return {
          orderId: r.orderId,
          email: r.email,
          name: r.name,
          paidAmount: r.paidAmount,
          refundedAmount: r.refundedAmount,
          refundableAmount: r.refundableAmount,
          proposalAmount: r.proposalAmount ?? 0,
          proposalReason: r.proposalReason,
          defaultDecidedAmount: 0,
          eligible: false,
          ineligibleReason: fixed > r.refundableAmount ? `환불 가능액(${r.refundableAmount.toLocaleString()}원) 초과` : "금액 오류",
        };
      }
      defaultAmount = fixed;
    } else {
      // policy 모드
      defaultAmount = Math.min(r.refundableAmount, Math.max(0, r.proposalAmount ?? 0));
    }

    return {
      orderId: r.orderId,
      email: r.email,
      name: r.name,
      paidAmount: r.paidAmount,
      refundedAmount: r.refundedAmount,
      refundableAmount: r.refundableAmount,
      proposalAmount: r.proposalAmount ?? 0,
      proposalReason: r.proposalReason,
      defaultDecidedAmount: defaultAmount,
      eligible: true,
      ineligibleReason: null,
    };
  });

  const eligibleRows = previewRows.filter((r) => r.eligible);
  const totalDecidedAmount = eligibleRows.reduce((sum, r) => sum + r.defaultDecidedAmount, 0);
  const partialCount = eligibleRows.filter((r) => r.defaultDecidedAmount < r.refundableAmount).length;
  const fullCount = eligibleRows.filter((r) => r.defaultDecidedAmount === r.refundableAmount).length;

  return {
    ok: true,
    batchId,
    mode,
    rows: previewRows,
    summary: {
      totalCount: previewRows.length,
      eligibleCount: eligibleRows.length,
      ineligibleCount: previewRows.length - eligibleRows.length,
      totalDecidedAmount,
      partialCount,
      fullCount,
    },
  };
}
