// 화면 표시 전용 — DB에는 대시 없이 16자 그대로 저장한다(조회/유니크 제약 단순화).
export function formatAccessCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}
