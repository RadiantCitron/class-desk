// 개설강의 회차(course_sessions, 날짜별 행)의 날짜·시간 표시 — 학생 화면(/student, /student/apply)과
// 관리자 상세가 같은 문구를 쓰도록 한 곳에 둔다. 날짜는 한국 달력 날짜 문자열("YYYY-MM-DD")이라 시간대 변환이 없다.
export const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;

export type SessionLike = {
  session_date: string;
  start_time: string;
  end_time: string;
  deactivated_at?: string | null;
};

function dayLabel(date: string): string {
  return DAY_LABELS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

function monthDay(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}(${dayLabel(date)})`;
}

function hhmm(range: SessionLike): string {
  return `${range.start_time.slice(0, 5)}~${range.end_time.slice(0, 5)}`;
}

/** 예: "11/3(화) 19:00~21:00" (시각은 HH:MM까지만). */
export function formatSession(session: SessionLike): string {
  return `${monthDay(session.session_date)} ${hhmm(session)}`;
}

function compareSessions(a: SessionLike, b: SessionLike): number {
  return a.session_date.localeCompare(b.session_date) || a.start_time.localeCompare(b.start_time);
}

/**
 * 활성 회차만 요약한다. 없으면 빈 문자열.
 * 1회: "11/3(화) 19:00~21:00" / 여러 회: "총 3회 · 11/3(화)~11/17(화) · 19:00~21:00"(시각이 모두 같을 때) 또는 "… · 시각은 회차마다 다름".
 */
export function formatSessions(sessions: SessionLike[]): string {
  const active = sessions.filter((s) => !s.deactivated_at).sort(compareSessions);
  if (active.length === 0) return "";
  if (active.length === 1) return formatSession(active[0]);
  const first = active[0];
  const last = active[active.length - 1];
  const sameTime = active.every((s) => hhmm(s) === hhmm(first));
  return `총 ${active.length}회 · ${monthDay(first.session_date)}~${monthDay(last.session_date)} · ${sameTime ? hhmm(first) : "시각은 회차마다 다름"}`;
}
