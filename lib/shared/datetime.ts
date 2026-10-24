// 화면에 보여 주는 시각은 한국 시간(Asia/Seoul)으로 고정한다. 서버 시간대(로컬 KST, 배포 서버 UTC)에 따라
// 동일한 시각 값이 다르게 렌더링되거나 폼 입력이 왜곡되는 현상을 원천 방지한다.
// 한국은 서머타임이 없어 UTC+9 고정이다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function formatKst(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

/**
 * `<input type="datetime-local">` 값("YYYY-MM-DDTHH:mm", 초는 있어도 됨)을 **한국 시간으로 해석**해 UTC ISO 문자열로
 * 바꾼다. 예전엔 `new Date(값)`이라 서버 시간대로 해석돼(배포 UTC면 9시간 어긋남) 등록·수정이 같은 규칙을 쓰게
 * 이 함수로 모은다.
 */
export function parseKstLocal(local: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/.exec(local.trim());
  if (!m) throw new Error(`시각 형식이 올바르지 않습니다: ${local}`);
  const date = new Date(`${m[1]}T${m[2]}${m[3] ?? ":00"}+09:00`);
  if (Number.isNaN(date.getTime())) throw new Error(`시각 형식이 올바르지 않습니다: ${local}`);
  return date.toISOString();
}

/** UTC ISO 시각을 `datetime-local` 입력의 값("YYYY-MM-DDTHH:mm", 한국 시간)으로. 없으면 빈 문자열. */
export function toKstLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + KST_OFFSET_MS).toISOString().slice(0, 16);
}

/**
 * DB가 준 시각 문자열(예: "2026-09-30T13:15:56.679+00:00") 두 개를 비교한다. 밀리초 단위로 먼저 비교하고,
 * 같으면 문자열로 마이크로초까지 비교한다(같은 형식이라 '+'가 숫자보다 작아 짧은 소수부가 먼저 온다).
 * 음수면 a가 더 이르다.
 */
export function compareTimestamps(a: string, b: string): number {
  const diff = Date.parse(a) - Date.parse(b);
  if (diff !== 0) return diff;
  return a < b ? -1 : a > b ? 1 : 0;
}
