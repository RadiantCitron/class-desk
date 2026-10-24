// 개설 폼 달력(SessionPicker)의 날짜 계산 — 순수 함수만 둔다.
// 날짜는 한국 달력 날짜 문자열("YYYY-MM-DD")이고 UTC 기준 산술만 쓴다(시간대 변환 없음).
// ui/** 는 lib/** 를 import할 수 없어(ui-layer 가드) 서버 검증(lib/orders/session-rows.ts)과 따로 있다 — 권위는 서버 검증이다.

export const MAX_SESSIONS = 100;
const DAY_MS = 86_400_000;
const MAX_SPAN_DAYS = 3660;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function toDateString(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** 0=일 … 6=토. 잘못된 날짜면 -1. */
export function dayOfWeek(value: string): number {
  return isValidDate(value) ? new Date(`${value}T00:00:00Z`).getUTCDay() : -1;
}

/** month는 1~12. 일요일 시작, 7칸씩 주 단위. 달 밖 칸은 null. */
export function monthGrid(year: number, month: number): (string | null)[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = first.getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(toDateString(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** from~until(양 끝 포함) 중 고른 요일(0=일~6=토)에 해당하는 날짜, 오름차순. 입력이 잘못되면 빈 배열. */
export function weekdayDates(from: string, until: string, days: number[]): string[] {
  if (!isValidDate(from) || !isValidDate(until)) return [];
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${until}T00:00:00Z`).getTime();
  if (start > end || (end - start) / DAY_MS > MAX_SPAN_DAYS) return [];
  const wanted = new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  const out: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) {
    const d = new Date(t);
    if (wanted.has(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * from부터 고른 요일(0=일~6=토)에 해당하는 날짜를 앞에서부터 count(1~MAX_SESSIONS)개 계산.
 * until이 주어지면 둘 중 먼저 도달하는 곳에서 멈춘다(양 끝 포함).
 * 잘못된 입력이거나 요일이 없으면 빈 배열.
 */
export function weekdayDatesN(from: string, count: number, days: number[], until?: string): string[] {
  if (!isValidDate(from) || !Number.isInteger(count) || count <= 0) return [];
  const targetCount = Math.min(count, MAX_SESSIONS);
  const wanted = new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  if (wanted.size === 0) return [];

  const start = new Date(`${from}T00:00:00Z`).getTime();
  const hasUntil = until !== undefined && until !== "" && isValidDate(until);
  const end = hasUntil ? new Date(`${until}T00:00:00Z`).getTime() : start + MAX_SPAN_DAYS * DAY_MS;
  if (start > end) return [];

  const out: string[] = [];
  for (let t = start; t <= end && out.length < targetCount; t += DAY_MS) {
    const d = new Date(t);
    if (wanted.has(d.getUTCDay())) {
      out.push(d.toISOString().slice(0, 10));
    }
  }
  return out;
}

