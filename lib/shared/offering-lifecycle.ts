// 개설강의 수명 표시 — DB 조회 없는 순수 함수(ADR-0022). 저장하는 것은 모집 상태(status 4종)와 종료 기록(ended_at)뿐이고,
// 「강의 중」「종료 처리 대기」 같은 표시는 날짜와 그 기록에서 계산한다 — 저장 수명 상태를 따로 두면 날짜와 어긋나는 이중 진실이 된다.
// 관리자(목록·상세)와 학생(내 수강 내역)이 같은 함수를 쓴다. 취소(폐강)와 종료는 다른 상태로 구분된다.

export type OfferingLifecycleInput = {
  status: string;
  recruit_opens_at: string | null;
  opens_at: string;
  ends_at: string | null;
  ended_at: string | null;
};

export type OfferingLifecycleCode =
  | "CANCELLING"
  | "CANCELLED"
  | "ENDED"
  | "END_PENDING"
  | "IN_PROGRESS"
  | "CLOSED"
  | "RECRUITING"
  | "BEFORE_RECRUIT";

export const OFFERING_LIFECYCLE_LABELS: Record<OfferingLifecycleCode, string> = {
  CANCELLING: "폐강중",
  CANCELLED: "폐강완료",
  ENDED: "종료",
  END_PENDING: "종료 처리 대기",
  IN_PROGRESS: "강의 중",
  CLOSED: "마감",
  RECRUITING: "모집중",
  BEFORE_RECRUIT: "모집 전",
};

/**
 * 우선순위: 폐강(취소) → 종료 기록 → 종강일 지남(종료 처리 대기) → 개강 지남(강의 중) → 마감 → 모집 기간 → 모집 전.
 * 폐강이 종료보다 앞선다(취소와 종료는 구분). 종강일이 없는 강의는 개강 뒤 계속 「강의 중」이고 수동 종료만 된다.
 */
export function offeringLifecycle(offering: OfferingLifecycleInput, now: Date = new Date()): OfferingLifecycleCode {
  if (offering.status === "CANCELLING") return "CANCELLING";
  if (offering.status === "CANCELLED") return "CANCELLED";
  if (offering.ended_at) return "ENDED";
  const t = now.getTime();
  if (offering.ends_at && new Date(offering.ends_at).getTime() <= t) return "END_PENDING";
  if (new Date(offering.opens_at).getTime() <= t) return "IN_PROGRESS";
  if (offering.status === "CLOSED") return "CLOSED";
  if (offering.recruit_opens_at && new Date(offering.recruit_opens_at).getTime() > t) return "BEFORE_RECRUIT";
  return "RECRUITING";
}

export function offeringLifecycleLabel(offering: OfferingLifecycleInput, now: Date = new Date()): string {
  return OFFERING_LIFECYCLE_LABELS[offeringLifecycle(offering, now)];
}
