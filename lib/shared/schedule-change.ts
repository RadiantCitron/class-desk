// 수강생이 있는 수업의 일정 변경 — 순수 함수. 변경·안내·응답은 새 테이블 없이 주문 이벤트의 사실로만 남는다.
//   · SCHEDULE_CHANGE_NOTICE   — 일정을 바꿀 때 살아 있는(승인 대기·승인됨) 주문마다 1건(payload: change_id, reason, before, after).
//   · SCHEDULE_CHANGE_ACCEPTED / SCHEDULE_CHANGE_DECLINED — 수강생의 응답(payload.notice_event_id가 안내를 가리킨다). 한 번 답하면 바꿀 수 없다.
//   「현재 상태」는 **가장 최근 안내**에 대한 것이다. 일정이 또 바뀌면 새 안내가 이전 응답을 대체하고 다시 동의가 필요하다.
//   DB 함수(exclude_order_for_schedule_change)도 같은 규칙을 쓴다.
import type { OrderEventLike } from "./refund-request";

export type SessionLine = { date: string; start: string; end: string };

export type ScheduleChangeStatus = "NOTIFIED" | "REFUND_REQUESTED" | "LEGACY_ACCEPTED" | "LEGACY_DECLINED";

export type ScheduleChangeState = {
  noticeId: string;
  changeId: string | null;
  status: ScheduleChangeStatus;
  noticedAt: string;
  reason: string;
  before: SessionLine[];
  after: SessionLine[];
};

const asLines = (value: unknown): SessionLine[] =>
  Array.isArray(value)
    ? value
        .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
        .map((v) => ({ date: String(v.date ?? ""), start: String(v.start ?? "").slice(0, 5), end: String(v.end ?? "").slice(0, 5) }))
    : [];

/** 주문의 가장 최근 일정 변경 안내와 그 상태(안내됨 / 환불 신청됨 / 과거 응답). 안내가 없거나 주문이 이미 종료됐으면 null. */
export function scheduleChangeState(events: OrderEventLike[], orderStatus: string): ScheduleChangeState | null {
  if (orderStatus === "CANCELLED") return null;
  const notice = events
    .filter((e) => e.event_type === "SCHEDULE_CHANGE_NOTICE")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!notice) return null;

  // 이 안내와 연결된 환불 신청이 있는지 확인
  const refundReq = events.find(
    (e) =>
      e.event_type === "REFUND_REQUESTED" &&
      ((e.payload?.proposal as { context?: { schedule_change_notice_event_id?: string } } | undefined)?.context
        ?.schedule_change_notice_event_id === notice.id ||
        (e.payload as { context?: { schedule_change_notice_event_id?: string } } | undefined)?.context
          ?.schedule_change_notice_event_id === notice.id),
  );

  // 과거 이벤트 호환
  const legacyResponse = events
    .filter((e) => (e.event_type === "SCHEDULE_CHANGE_ACCEPTED" || e.event_type === "SCHEDULE_CHANGE_DECLINED") && e.payload?.notice_event_id === notice.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  let status: ScheduleChangeStatus = "NOTIFIED";
  if (refundReq) {
    status = "REFUND_REQUESTED";
  } else if (legacyResponse) {
    status = legacyResponse.event_type === "SCHEDULE_CHANGE_ACCEPTED" ? "LEGACY_ACCEPTED" : "LEGACY_DECLINED";
  }

  const payload = notice.payload ?? {};
  return {
    noticeId: notice.id,
    changeId: typeof payload.change_id === "string" ? payload.change_id : null,
    status,
    noticedAt: notice.created_at,
    reason: typeof payload.reason === "string" ? payload.reason : "",
    before: asLines(payload.before),
    after: asLines(payload.after),
  };
}

/** 관리자가 미결제/무료 수강생을 제외 처리할 수 있는 상태인가 — 안내가 있으면 가능. */
export function canExcludeForScheduleChange(state: ScheduleChangeState | null): boolean {
  return state !== null;
}

export const SCHEDULE_CHANGE_STATUS_LABELS: Record<ScheduleChangeStatus, string> = {
  NOTIFIED: "안내됨",
  REFUND_REQUESTED: "환불 신청됨",
  LEGACY_ACCEPTED: "동의(과거 기록)",
  LEGACY_DECLINED: "미동의(과거 기록)",
};

/** 안내 후 경과 일수(24시간 단위, 내림) — 참고 표시. */
export function noticeAgeDays(noticedAt: string, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(noticedAt).getTime()) / 86_400_000));
}

const key = (l: SessionLine) => `${l.date}|${l.start.slice(0, 5)}|${l.end.slice(0, 5)}`;

/**
 * 현재 활성 회차(id 포함)와 관리자가 달력에서 만든 원하는 회차 목록을 비교해, 취소할 회차 id와 추가할 회차를 계산한다.
 * (날짜,시작,종료)가 같으면 그대로 두고, 같은 날짜의 시각만 바꾼 경우는 취소 + 추가가 된다. 시각은 HH:MM까지만 비교한다.
 */
export function diffSessions(
  current: { id: string; date: string; start: string; end: string }[],
  desired: SessionLine[],
): { cancelIds: string[]; add: SessionLine[] } {
  const desiredKeys = new Map(desired.map((d) => [key(d), d]));
  const currentKeys = new Set(current.map((c) => key(c)));
  const cancelIds = current.filter((c) => !desiredKeys.has(key(c))).map((c) => c.id);
  const add = desired.filter((d) => !currentKeys.has(key(d)));
  return { cancelIds, add };
}

/** 예: 「11/3(화) 19:00~21:00, 11/10(화) 19:00~21:00」 — 안내 화면·메일용 한 줄 요약. */
export function describeLines(lines: SessionLine[]): string {
  if (lines.length === 0) return "(없음)";
  const dow = ["일", "월", "화", "수", "목", "금", "토"];
  return [...lines]
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))
    .map((l) => {
      const [, m, d] = l.date.split("-");
      return `${Number(m)}/${Number(d)}(${dow[new Date(`${l.date}T00:00:00Z`).getUTCDay()]}) ${l.start.slice(0, 5)}~${l.end.slice(0, 5)}`;
    })
    .join(", ");
}

/** 변경 전/후 일정을 비교하여 바뀐(추가되거나 시간/날짜가 변경된) 회차에 (변경) 표시를 붙여 요약한다. */
export function describeChangedLines(before: SessionLine[], after: SessionLine[]): string {
  if (after.length === 0) return "(없음)";
  const beforeKeys = new Set(before.map(key));
  const dow = ["일", "월", "화", "수", "목", "금", "토"];
  return [...after]
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))
    .map((l) => {
      const [, m, d] = l.date.split("-");
      const base = `${Number(m)}/${Number(d)}(${dow[new Date(`${l.date}T00:00:00Z`).getUTCDay()]}) ${l.start.slice(0, 5)}~${l.end.slice(0, 5)}`;
      return beforeKeys.has(key(l)) ? base : `${base} (변경)`;
    })
    .join(", ");
}

/** 시작까지 2시간 이내인 회차를 변경(취소 또는 추가)하는지 판정 . */
export function isImminentScheduleChange(
  sessionsToCancel: { date: string; start: string }[],
  sessionsToAdd: SessionLine[],
  now: Date = new Date(),
): boolean {
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const nowMs = now.getTime();

  for (const s of sessionsToCancel) {
    const time = s.start.slice(0, 5);
    const startMs = new Date(`${s.date}T${time}:00+09:00`).getTime();
    if (startMs > nowMs && startMs - nowMs <= twoHoursMs) {
      return true;
    }
  }

  for (const s of sessionsToAdd) {
    const time = s.start.slice(0, 5);
    const startMs = new Date(`${s.date}T${time}:00+09:00`).getTime();
    if (startMs > nowMs && startMs - nowMs <= twoHoursMs) {
      return true;
    }
  }

  return false;
}
