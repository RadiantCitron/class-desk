// 버셀 홈페이지에서 올린 파일의 경로(pathname)만 우리 장부에 적는다.
// 전체 Blob URL을 저장하거나 화면에 보여 주지 않는다(2026-09-15 수정하기로 한 것 D).

const PATHNAME_PATTERN = /^[A-Za-z0-9._\-]+(?:\/[A-Za-z0-9._\-]+)*$/;
const MAX_PATHNAME_LENGTH = 200;

export function parseBlobPathname(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+/, "");

  if (!trimmed) {
    throw new Error("파일 경로가 비어 있습니다.");
  }
  if (trimmed.includes("://") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new Error("파일 경로는 버셀 Blob pathname만 넣으세요. 전체 주소는 안 됩니다.");
  }
  if (trimmed.length > MAX_PATHNAME_LENGTH) {
    throw new Error("파일 경로가 너무 깁니다.");
  }
  if (!PATHNAME_PATTERN.test(trimmed)) {
    throw new Error("파일 경로에 쓸 수 없는 문자가 있습니다.");
  }

  return trimmed;
}

export function downloadFilename(pathname: string): string {
  const name = pathname.split("/").filter(Boolean).at(-1);
  if (!name) {
    throw new Error("파일 이름이 없습니다.");
  }
  return name;
}

export function contentDispositionAttachment(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\\r\n]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
