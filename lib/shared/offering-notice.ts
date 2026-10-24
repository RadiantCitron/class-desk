export function normalizeOfferingNotice(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > 1000) {
    throw new Error("공지문은 최대 1,000자까지 입력할 수 있습니다.");
  }
  return trimmed;
}
