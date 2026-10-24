// 환불 제안 — 버전 붙은 정책 데이터 표 + 평가 함수 하나.
// **제안일 뿐이다.** 약관이 정본이고(약관과 이 표를 맞추는 일은 운영자 몫), 계산액으로 자동 환불하지 않으며, 관리자는 언제든 금액을 조정하거나
// 직권으로 환불한다. 순수 함수만 둔다(import 없음, DB 접근 없음) — 관리자 환불 패널 표시, 서버 감사 기록, 이후 수강생 환불 신청이 모두 이 함수 하나를 쓴다.
//
// 정책 바꾸는 법(ADR-0025): 옛 버전은 수정·삭제하지 않는다. 새 버전을 REFUND_POLICIES에 추가 → 단위 시험(불변식·경계값·새 골든) → CURRENT_REFUND_POLICY_ID 변경
// → 약관 새 버전 등록(운영자) → **새 주문부터** 적용(주문이 만들어질 때 그 시점의 현재 버전이 orders.refund_policy_version에 고정된다).
// 옛 버전의 골든 시험(refund-policy.test.ts)이 깨지면 옛 버전을 고친 것이다 — 되돌릴 것.
//
// 날짜는 한국 달력 날짜("YYYY-MM-DD") 문자열이고 일수는 UTC 자정 차이로 센다(시간대 변환 없음). 당일 회차는 시각과 무관하게 수업받은 것으로 본다.

export type Fraction = { n: number; d: number };

export type RefundPolicy = {
  id: string;
  label: string;
  /** 개강 전 단계 — 첫 회차 날짜까지 남은 일수가 minDaysBefore 이상이면 ratio. minDaysBefore 내림차순. */
  beforeStart: { minDaysBefore: number; ratio: Fraction }[];
  /** 개강 후 구간 — 경과비(지난 회차 시간 ÷ 총 수업시간)가 elapsedBelow 미만이면 ratio. elapsedBelow 오름차순. 마지막 구간 이상이면 불가. */
  afterStart: { elapsedBelow: Fraction; ratio: Fraction }[];
  /** 위약금 — 활성 회차가 minSessions개 이상이고(requireDiscount면 할인받았고) 개강 후 구간일 때만 비율만큼 더 뺀다(개강 전에는 이중 차감하지 않는다). */
  penalty: { ratio: Fraction; minSessions: number; requireDiscount: boolean; afterStartOnly: boolean };
  notice: string;
};

export const REFUND_POLICIES: Record<string, RefundPolicy> = {
  "2026-10-v1": {
    id: "2026-10-v1",
    label: "2026-10 v1",
    beforeStart: [
      { minDaysBefore: 7, ratio: { n: 1, d: 1 } },
      { minDaysBefore: 3, ratio: { n: 7, d: 10 } },
      { minDaysBefore: 1, ratio: { n: 3, d: 10 } },
    ],
    afterStart: [
      { elapsedBelow: { n: 1, d: 3 }, ratio: { n: 2, d: 3 } },
      { elapsedBelow: { n: 1, d: 2 }, ratio: { n: 1, d: 2 } },
    ],
    penalty: { ratio: { n: 1, d: 10 }, minSessions: 2, requireDiscount: true, afterStartOnly: true },
    notice: "제안일 뿐 자동으로 환불되지 않습니다. 약관이 정본입니다. 관리자는 금액을 조정하거나 직권으로 전액·부분 환불할 수 있습니다.",
  },
};

/** 새 주문이 만들어질 때 주문에 고정되는 버전. */
export const CURRENT_REFUND_POLICY_ID = "2026-10-v1";

/** 정책 버전이 기록되지 않은 주문(이 컬럼이 생기기 전 주문)을 계산할 때 쓰는 버전. 새 버전을 추가하기 전에 이 규칙을 다시 정해야 한다(ADR-0025). */
export const LEGACY_REFUND_POLICY_ID = "2026-10-v1";

/** 환불 제안을 보여 줄 주문인가 — 승인되고 결제 완료된 수업 주문만(이미 종료된 주문의 추가 환불은 「남은 금액」이 기준이라 제안하지 않는다). */
export function canProposeRefund(order: { course_offering_id: string | null; status: string; payment_status: string }): boolean {
  return order.course_offering_id !== null && order.status === "APPROVED" && order.payment_status === "PAID";
}

export function getRefundPolicy(id: string): RefundPolicy {
  const policy = REFUND_POLICIES[id];
  if (!policy) throw new Error(`알 수 없는 환불 정책 버전입니다: ${id}`);
  return policy;
}

export type RefundSession = { session_date: string; start_time: string; end_time: string; deactivated_at?: string | null };

export type RefundInput = {
  /** 실제 지불금액(orders.final_amount). */
  paid: number;
  /** 지금 환불할 수 있는 잔액(결제 원장 기준). 제안은 이 값을 넘지 않는다. */
  refundable: number;
  /** 정가(orders.list_price). 지불액보다 크면 할인받은 것. */
  listPrice: number | null;
  sessions: RefundSession[];
  /** 오늘의 한국 날짜. */
  today: string;
  /** 주문에 고정된 정책 버전. null이면 LEGACY_REFUND_POLICY_ID로 계산하고 policyNote에 밝힌다. */
  policyId: string | null;
};

export type RefundStage = "BEFORE_START" | "AFTER_START" | "NOT_ALLOWED" | "NO_SESSIONS";

export type RefundProposal = {
  eligible: boolean;
  stage: RefundStage;
  amount: number;
  /** 적용한 구간 비율(불가·회차 없음이면 null). */
  ratio: Fraction | null;
  /** 실제로 적용한 위약금 비율(미적용이면 null). */
  penalty: Fraction | null;
  /** 개강 전이면 첫 회차까지 남은 일수. */
  daysBefore: number | null;
  /** 개강 후이면 지난 회차 분 합과 총 수업 분. */
  elapsed: { pastMinutes: number; totalMinutes: number } | null;
  policyId: string;
  /** 정책 버전을 주문에서 못 찾아 대신 쓴 경우의 안내. */
  policyNote: string | null;
  headline: string;
  detail: string;
  notice: string;
};

function minutes(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

function dayDiff(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);
}

export function fractionText(f: Fraction): string {
  return (f.n * 100) % f.d === 0 ? `${(f.n * 100) / f.d}%` : `${f.n}/${f.d}`;
}

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export function evaluateRefund(input: RefundInput): RefundProposal {
  const policyId = input.policyId ?? LEGACY_REFUND_POLICY_ID;
  const policy = getRefundPolicy(policyId);
  const policyNote = input.policyId ? null : `정책 버전이 기록되지 않은 주문이라 ${LEGACY_REFUND_POLICY_ID}로 계산했습니다.`;

  const base = { policyId, policyNote, notice: policy.notice };
  const none = (stage: RefundStage, headline: string, detail: string): RefundProposal => ({
    ...base, eligible: false, stage, amount: 0, ratio: null, penalty: null, daysBefore: null, elapsed: null, headline, detail,
  });

  const active = input.sessions.filter((s) => !s.deactivated_at);
  if (active.length === 0) {
    return none("NO_SESSIONS", "제안할 수 없음(회차 정보 없음)", "이 주문의 수업에 활성 회차가 없어 약관 기준을 계산하지 못했습니다. 관리자가 금액을 직접 정하세요.");
  }
  const dates = active.map((s) => s.session_date).sort();
  const first = dates[0];
  const totalMinutes = active.reduce((sum, s) => sum + (minutes(s.end_time) - minutes(s.start_time)), 0);
  if (totalMinutes <= 0) {
    return none("NO_SESSIONS", "제안할 수 없음(회차 시간 오류)", "회차의 시작·종료 시각이 올바르지 않아 계산하지 못했습니다.");
  }

  let stage: RefundStage;
  let ratio: Fraction | null = null;
  let daysBefore: number | null = null;
  let elapsed: { pastMinutes: number; totalMinutes: number } | null = null;

  if (first > input.today) {
    daysBefore = dayDiff(input.today, first);
    const rule = policy.beforeStart.find((r) => daysBefore! >= r.minDaysBefore);
    stage = rule ? "BEFORE_START" : "NOT_ALLOWED";
    ratio = rule ? rule.ratio : null;
  } else {
    const pastMinutes = active
      .filter((s) => s.session_date <= input.today)
      .reduce((sum, s) => sum + (minutes(s.end_time) - minutes(s.start_time)), 0);
    elapsed = { pastMinutes, totalMinutes };
    // 경과비 < n/d ⇔ pastMinutes × d < totalMinutes × n (정수 비교)
    const rule = policy.afterStart.find((r) => pastMinutes * r.elapsedBelow.d < totalMinutes * r.elapsedBelow.n);
    stage = rule ? "AFTER_START" : "NOT_ALLOWED";
    ratio = rule ? rule.ratio : null;
  }

  const timing =
    daysBefore !== null
      ? `개강까지 ${daysBefore}일`
      : `경과 ${elapsed!.pastMinutes}/${elapsed!.totalMinutes}분(지난 회차는 당일 포함)`;

  if (!ratio) {
    return {
      ...base, eligible: false, stage: "NOT_ALLOWED", amount: 0, ratio: null, penalty: null, daysBefore, elapsed,
      headline: "약관 기준으로는 환불 불가",
      detail: `${timing} — 환불 가능한 구간이 아닙니다. 관리자는 직권으로 환불할 수 있습니다. (정책 ${policyId})`,
    };
  }

  const discounted = input.listPrice !== null && input.listPrice > input.paid;
  const penaltyApplies =
    (!policy.penalty.afterStartOnly || stage === "AFTER_START") &&
    active.length >= policy.penalty.minSessions &&
    (!policy.penalty.requireDiscount || discounted);
  const penalty = penaltyApplies ? policy.penalty.ratio : null;

  // 금액 = ⌊ 지불액 × (구간 비율 − 위약금 비율) ⌋ — 분수로 계산해 마지막에 한 번만 버린다.
  const rn = penalty ? ratio.n * penalty.d - penalty.n * ratio.d : ratio.n;
  const rd = penalty ? ratio.d * penalty.d : ratio.d;
  const raw = rn <= 0 ? 0 : Math.floor((input.paid * rn) / rd);
  const amount = Math.max(0, Math.min(raw, Math.max(0, input.refundable)));

  const parts = [`지불 ${won(input.paid)}`, timing, `구간 ${fractionText(ratio)}`];
  if (penalty) parts.push(`위약금 ${fractionText(penalty)} 공제(할인받은 다회차, 개강 후)`);
  if (amount < raw) parts.push(`환불 가능액 ${won(input.refundable)}로 제한`);
  parts.push(`정책 ${policyId}`);

  return {
    ...base, eligible: true, stage, amount, ratio, penalty, daysBefore, elapsed,
    headline: `약관 기준 제안: ${won(amount)} (${daysBefore !== null ? `개강 ${daysBefore}일 전` : "개강 후"} · ${fractionText(ratio)}${penalty ? ` − 위약금 ${fractionText(penalty)}` : ""})`,
    detail: parts.join(" · "),
  };
}

/**
 * 특정 회차 취소에 대한 보상 환불(수강 유지 부분 환불) 제안 금액 계산.
 * 산식: (취소 회차 수업 분 ÷ 활성+해당 취소 회차 총 수업 분) × 실제 결제액 (1원 단위 버림).
 * 환불 가능액(refundable)을 초과할 수 없다.
 */
export function calculateSessionCompensation(input: {
  paid: number;
  refundable: number;
  allSessions: RefundSession[];
  cancelledSessionDate: string;
}): { amount: number; cancelledMinutes: number; totalMinutes: number } {
  const cancelled = input.allSessions.find((s) => s.session_date === input.cancelledSessionDate);
  if (!cancelled) {
    return { amount: 0, cancelledMinutes: 0, totalMinutes: 0 };
  }
  const cancelledMinutes = Math.max(0, minutes(cancelled.end_time) - minutes(cancelled.start_time));
  // 대상 회차들(활성 회차 + 지금 취소하려는 회차)
  const targetSessions = input.allSessions.filter(
    (s) => !s.deactivated_at || s.session_date === input.cancelledSessionDate,
  );
  const totalMinutes = targetSessions.reduce(
    (sum, s) => sum + Math.max(0, minutes(s.end_time) - minutes(s.start_time)),
    0,
  );
  if (totalMinutes <= 0 || cancelledMinutes <= 0) {
    return { amount: 0, cancelledMinutes, totalMinutes };
  }

  const raw = Math.floor((input.paid * cancelledMinutes) / totalMinutes);
  const amount = Math.max(0, Math.min(raw, Math.max(0, input.refundable)));
  return { amount, cancelledMinutes, totalMinutes };
}

