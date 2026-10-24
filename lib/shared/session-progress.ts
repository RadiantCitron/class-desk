// 회차에서 파생되는 값(총/지난/다음 회차)의 TS 정의 — ADR-0023·0026.
// DB 쪽 정의는 SQL 함수 offering_session_stats다. **같은 정의가 두 곳에 있으므로 바꾸면 둘을 같이 고친다**
// (같은 데이터에서 결과가 같은지 lib/orders/session-progress.integration.test.ts가 확인한다).
//   · 활성(deactivated_at이 없는) 회차만 센다.
//   · 날짜는 한국 달력 날짜 문자열("YYYY-MM-DD")이라 비교는 문자열 비교다.
//   · 지난 회차 = session_date <= 오늘(KST) — 당일 포함(환불 정책의 「당일 = 수업받은 것」과 같은 기준).
//   · 다음 회차 = session_date > 오늘 중 가장 이른 날짜.

export type SessionProgressInput = { session_date: string; deactivated_at?: string | null };

export type SessionProgress = {
  total: number;
  past: number;
  first: string | null;
  last: string | null;
  next: string | null;
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 지금의 한국 달력 날짜("YYYY-MM-DD"). */
export function todayKst(now: Date = new Date()): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 회차가 이미 시작되었는지 판정 — DB의 session_has_started(p_date, p_start)와 정확히 일치(한국 표준시 기준 시작 시각 <= 현재). */
export function sessionHasStarted(sessionDate: string, startTime: string, now: Date = new Date()): boolean {
  const time = startTime.slice(0, 5);
  const isoKst = `${sessionDate}T${time}:00+09:00`;
  return new Date(isoKst).getTime() <= now.getTime();
}

export function summarizeSessions(sessions: SessionProgressInput[], today: string = todayKst()): SessionProgress {
  const dates = sessions
    .filter((s) => !s.deactivated_at)
    .map((s) => s.session_date)
    .sort();
  return {
    total: dates.length,
    past: dates.filter((d) => d <= today).length,
    first: dates[0] ?? null,
    last: dates[dates.length - 1] ?? null,
    next: dates.find((d) => d > today) ?? null,
  };
}

/** 예: 「총 4회 · 지난 2회 · 다음 11/17(화)」. 활성 회차가 없으면 빈 문자열. */
export function formatProgress(progress: SessionProgress): string {
  if (progress.total === 0) return "";
  const parts = [`총 ${progress.total}회`, `지난 ${progress.past}회`];
  if (progress.next) {
    const [, m, d] = progress.next.split("-");
    const dow = ["일", "월", "화", "수", "목", "금", "토"][new Date(`${progress.next}T00:00:00Z`).getUTCDay()];
    parts.push(`다음 ${Number(m)}/${Number(d)}(${dow})`);
  }
  return parts.join(" · ");
}
