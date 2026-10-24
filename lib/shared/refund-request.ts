// 수강생 환불 신청 — 순수 함수. 신청·거절은 새 테이블 없이 주문 이벤트(order_events)의 사실로만 남고,
// 「열린 신청」은 이벤트에서 판정한다. DB 함수(request_order_refund·reject_order_refund_request)도 같은 규칙을 쓴다(아래 정의 참고).
//
//   열린 신청 = REFUND_REQUESTED 이벤트 중 (1) 그것을 가리키는 REFUND_REQUEST_REJECTED(payload.request_event_id)가 없고
//               (2) 주문이 아직 CANCELLED가 아닌 것. 여러 개면 가장 최근 것. (환불로 주문이 끝나면 신청도 닫힌다.)
//   시각 비교를 쓰지 않는 이유: 같은 트랜잭션 안의 이벤트는 created_at이 같을 수 있어(시험) 순서 비교가 모호해진다.
import type { RefundProposal } from "./refund-policy";

export type OrderEventLike = {
  id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

export function findOpenStudentRefundRequest(events: OrderEventLike[], orderStatus: string): OrderEventLike | null {
  if (orderStatus === "CANCELLED") return null;
  const rejected = new Set(
    events
      .filter((e) => e.event_type === "REFUND_REQUEST_REJECTED")
      .map((e) => (typeof e.payload?.request_event_id === "string" ? e.payload.request_event_id : "")),
  );
  const open = events
    .filter((e) => e.event_type === "REFUND_REQUESTED" && !rejected.has(e.id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return open[0] ?? null;
}

/** 가장 최근에 거절된 신청의 거절 사건(열린 신청이 없을 때 학생에게 사유를 보여 주려는 용도). 이후 다시 신청한 적이 있으면 null. */
export function findLastRejection(events: OrderEventLike[], orderStatus: string): OrderEventLike | null {
  if (orderStatus === "CANCELLED") return null;
  if (findOpenStudentRefundRequest(events, orderStatus)) return null;
  const rejections = events.filter((e) => e.event_type === "REFUND_REQUEST_REJECTED").sort((a, b) => b.created_at.localeCompare(a.created_at));
  return rejections[0] ?? null;
}

/** 신청 후 경과 일수(24시간 단위, 내림). 학원법 기준 「사유 발생일부터 5일」을 참고로 보이는 표시용이며 법적 기한 판정이 아니다. */
export function requestAgeDays(requestedAt: string, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(requestedAt).getTime()) / 86_400_000));
}

export const REQUEST_WARN_DAYS = 3;
export const REQUEST_ALERT_DAYS = 5;

export type RequestAgeLevel = "NORMAL" | "WARN" | "ALERT";
export function requestAgeLevel(days: number): RequestAgeLevel {
  return days >= REQUEST_ALERT_DAYS ? "ALERT" : days >= REQUEST_WARN_DAYS ? "WARN" : "NORMAL";
}

/**
 * 수강생이 환불을 신청할 때 약관 기준으로 환불할 수 없는 구간일 때 보여 주는 접수 경고 안내.
 * 신청은 정상 접수되며 관리자가 검토해 결정함을 안내한다.
 */
export function refundBlockedMessage(proposal: RefundProposal): string {
  if (proposal.stage === "NO_SESSIONS") {
    return "이 수업의 일정 정보를 확인할 수 없습니다. 신청은 접수되며 관리자가 검토해 결정합니다.";
  }
  return "약관상 환불 기준에 해당하지 않는 구간입니다. 신청은 접수되며 관리자가 검토해 결정합니다. 환불이 거절될 수 있습니다.";
}

/** 학생에게 보여 주는 신청 확인 문구(약관 기준 예상 금액 또는 불가 구간 안내). */
export function studentProposalText(proposal: RefundProposal): string {
  if (!proposal.eligible) {
    return refundBlockedMessage(proposal);
  }
  return `약관 기준 예상 환불액은 ${proposal.amount.toLocaleString("ko-KR")}원입니다(${proposal.headline.replace(/^약관 기준 제안: [\d,]+원 /, "")}). 예상일 뿐이며, 신청하면 관리자가 검토한 뒤 확정합니다.`;
}

export type ProposalSnapshotSummary = {
  policyId?: string;
  policyNote?: string | null;
  stage?: string;
  eligible?: boolean;
  amount?: number;
  ratio?: { n: number; d: number } | null;
  penalty?: { n: number; d: number } | null;
  daysBefore?: number | null;
  elapsed?: { pastMinutes: number; totalMinutes: number } | null;
  error?: string;
};

/**
 * 신청 시점에 저장된 스냅샷 구조화 값(stage, ratio, daysBefore, elapsed, penalty)에서
 * 근거 문장을 생성하는 순수 함수 (A-2, A7 문장은 구조화 값에서 생성).
 */
export function describeSnapshot(proposal: ProposalSnapshotSummary | null | undefined): string {
  if (!proposal) return "신청 시점 제안 정보 없음";
  if (proposal.error) return `제안 계산 오류: ${proposal.error}`;
  if (proposal.eligible === false || proposal.stage === "NOT_ALLOWED") {
    return "신청 시점에 약관상 환불 불가 구간";
  }
  if (proposal.stage === "NO_SESSIONS") {
    return "신청 시점에 회차 정보 없음";
  }

  const parts: string[] = [];
  if (proposal.daysBefore != null) {
    parts.push(`개강 ${proposal.daysBefore}일 전`);
  } else if (proposal.elapsed != null) {
    parts.push(`경과 ${proposal.elapsed.pastMinutes}/${proposal.elapsed.totalMinutes}분`);
  }

  if (proposal.ratio) {
    const pct =
      (proposal.ratio.n * 100) % proposal.ratio.d === 0
        ? `${(proposal.ratio.n * 100) / proposal.ratio.d}%`
        : `${proposal.ratio.n}/${proposal.ratio.d}`;
    parts.push(pct);
  }

  if (proposal.penalty) {
    const penaltyPct =
      (proposal.penalty.n * 100) % proposal.penalty.d === 0
        ? `${(proposal.penalty.n * 100) / proposal.penalty.d}%`
        : `${proposal.penalty.n}/${proposal.penalty.d}`;
    parts.push(`위약금 ${penaltyPct} 차감`);
  }

  const amt = typeof proposal.amount === "number" ? `${proposal.amount.toLocaleString("ko-KR")}원` : "-";
  const desc = parts.length > 0 ? ` (${parts.join(" · ")})` : "";
  const policy = proposal.policyId ? ` [정책 ${proposal.policyId}]` : "";
  return `${amt}${desc}${policy}`;
}

