import { createAdminClient } from "@/lib/supabase/admin";
import { one } from "@/lib/supabase/relations";
import { canProposeRefund, evaluateRefund, type RefundProposal } from "@/lib/shared/refund-policy";
import { todayKst } from "@/lib/shared/session-progress";

// 환불 제안을 서버에서 다시 계산한다(ADR-0025 결정 5) — 관리자 환불 요청 감사 기록에 「그때의 제안」을 남기려는 용도다.
// 화면에 보인 값을 믿지 않고 같은 순수 함수(lib/shared/refund-policy.ts)로 다시 계산한다. 주문·회차(둘 다 주문 모듈 소유)만 읽고, 환불 가능액은 호출자가
// 이미 가진 값을 넘긴다(결제 원장은 읽지 않는다 — R1). 제안 대상이 아닌 주문(물품, 승인·결제완료가 아님)이면 null. 모르는 정책 버전이면 던진다.
export async function loadRefundProposal(orderId: string, refundable?: number, today?: string): Promise<RefundProposal | null> {
  const admin = createAdminClient();
  const { data: order, error } = await admin
    .from("orders")
    .select(
      "id, status, payment_status, list_price, final_amount, refunded_amount, refund_policy_version, course_offering_id, course_offerings(course_sessions(session_date, start_time, end_time, deactivated_at))",
    )
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw new Error(`환불 제안용 주문 조회 실패: ${error.message}`);
  if (!order || !canProposeRefund(order) || order.final_amount === null) return null;

  return evaluateRefund({
    paid: order.final_amount,
    // 호출자가 결제 원장 기준 가능액을 주면 그 값을, 아니면(학생 신청) 주문 기준 잔액을 쓴다. 승인됨+결제완료 주문은 부분 환불이 곧 종료라 환불 이력이 없다.
    refundable: refundable ?? order.final_amount - order.refunded_amount,
    listPrice: order.list_price,
    sessions: one(order.course_offerings)?.course_sessions ?? [],
    today: today ?? todayKst(),
    policyId: order.refund_policy_version,
  });
}

/** 감사 기록에 남길 요약(긴 문구는 빼고 입력·결과만). */
export function summarizeProposal(proposal: RefundProposal | null, error?: string) {
  if (error) return { error };
  if (!proposal) return null;
  return {
    policyId: proposal.policyId,
    policyNote: proposal.policyNote,
    stage: proposal.stage,
    eligible: proposal.eligible,
    amount: proposal.amount,
    ratio: proposal.ratio,
    penalty: proposal.penalty,
    daysBefore: proposal.daysBefore,
    elapsed: proposal.elapsed,
  };
}

export type SnapshotProposalSummary = {
  policyId?: string;
  policyNote?: string | null;
  stage?: RefundProposal["stage"];
  eligible?: boolean;
  amount?: number;
  ratio?: RefundProposal["ratio"];
  penalty?: RefundProposal["penalty"];
  daysBefore?: number | null;
  elapsed?: RefundProposal["elapsed"];
  error?: string;
};

export type RequestSnapshot = {
  requestedOn: string | null;
  proposal: SnapshotProposalSummary | null;
};

/**
 * REFUND_REQUESTED 주문 이벤트 payload에서 {requestedOn, proposal} 스냅샷을 추출한다.
 * proposal이 없거나 비어 있으면 null.
 */
export function readRequestSnapshot(payload: Record<string, unknown> | null | undefined): RequestSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const rawProposal = payload.proposal;
  if (!rawProposal || typeof rawProposal !== "object") return null;

  const p = rawProposal as Record<string, unknown>;
  const requestedOn = typeof payload.requested_on === "string" ? payload.requested_on : null;

  // proposal에 amount나 stage 같은 핵심 필드가 없으면 유효한 스냅샷으로 보지 않는다 (S-5 이전 빈 객체 대비)
  if (typeof p.amount !== "number" && typeof p.stage !== "string" && typeof p.error !== "string") {
    return null;
  }

  const proposal: SnapshotProposalSummary = {
    policyId: typeof p.policyId === "string" ? p.policyId : undefined,
    policyNote: typeof p.policyNote === "string" ? p.policyNote : null,
    stage: typeof p.stage === "string" ? (p.stage as RefundProposal["stage"]) : undefined,
    eligible: typeof p.eligible === "boolean" ? p.eligible : undefined,
    amount: typeof p.amount === "number" ? p.amount : undefined,
    ratio: (p.ratio && typeof p.ratio === "object" ? p.ratio : null) as RefundProposal["ratio"],
    penalty: (p.penalty && typeof p.penalty === "object" ? p.penalty : null) as RefundProposal["penalty"],
    daysBefore: typeof p.daysBefore === "number" ? p.daysBefore : null,
    elapsed: (p.elapsed && typeof p.elapsed === "object" ? p.elapsed : null) as RefundProposal["elapsed"],
    error: typeof p.error === "string" ? p.error : undefined,
  };

  return {
    requestedOn,
    proposal,
  };
}


export type AmountDefault = {
  mode: "full" | "partial" | "none";
  amount: number | null;
};

/**
 * 스냅샷과 현재 환불 가능 잔액을 바탕으로 관리자 승인 화면의 기본 입력 모드와 금액을 계산한다 (A-2 순수 함수).
 * - 스냅샷이 없거나, eligible이 false인 경우: 기본값 없음 (mode: 'none' / 관리자 직접 입력)
 * - snapshotAmount >= refundable: mode: 'full', amount: refundable
 * - snapshotAmount < refundable: mode: 'partial', amount: snapshotAmount
 */
export function buildAmountDefault(
  snapshot: RequestSnapshot | null | undefined,
  refundable: number,
): AmountDefault {
  if (!snapshot || !snapshot.proposal) {
    return { mode: "none", amount: null };
  }

  const p = snapshot.proposal;
  if (p.eligible === false || typeof p.amount !== "number" || p.amount <= 0) {
    return { mode: "none", amount: null };
  }

  if (p.amount >= refundable) {
    return { mode: "full", amount: refundable };
  }

  return { mode: "partial", amount: p.amount };
}

