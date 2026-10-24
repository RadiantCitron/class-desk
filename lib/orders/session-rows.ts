// 개설 폼이 보낸 회차 목록(JSON)을 서버에서 검증한다. 화면의 달력·요일 채우기는 편의일 뿐이고
// 저장 전 최종 판정은 여기와 DB(create_course_offering, 겹침 제약)가 한다. 날짜는 한국 달력 날짜 문자열이다.

export type SessionRow = { date: string; start: string; end: string };

export const MAX_SESSIONS_PER_OFFERING = 100;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** 오류는 모두 사용자에게 보여도 되는 한국어 메시지의 Error. 성공하면 날짜·시작 순으로 정렬해 돌려준다. */
export function parseSessionRows(raw: string): SessionRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("회차 목록 형식이 올바르지 않습니다.");
  }
  if (!Array.isArray(parsed)) throw new Error("회차 목록 형식이 올바르지 않습니다.");
  if (parsed.length === 0) throw new Error("회차를 1개 이상 선택해 주세요.");
  if (parsed.length > MAX_SESSIONS_PER_OFFERING) {
    throw new Error(`회차는 최대 ${MAX_SESSIONS_PER_OFFERING}개까지 만들 수 있습니다.`);
  }

  const rows: SessionRow[] = parsed.map((item) => {
    if (typeof item !== "object" || item === null) throw new Error("회차 목록 형식이 올바르지 않습니다.");
    const { date, start, end } = item as Record<string, unknown>;
    if (typeof date !== "string" || typeof start !== "string" || typeof end !== "string") {
      throw new Error("회차 목록 형식이 올바르지 않습니다.");
    }
    if (!isRealDate(date)) throw new Error(`회차 날짜가 올바르지 않습니다: ${date}`);
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw new Error(`회차 시각 형식이 올바르지 않습니다(${date}).`);
    if (start >= end) throw new Error(`회차 종료 시각은 시작 시각보다 늦어야 합니다(${date}).`);
    return { date, start, end };
  });

  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}
