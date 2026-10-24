import { issueSignedToken, presignUrl } from "@vercel/blob";

// 브라우저에는 Blob 주소를 주지 않는다. 서버가 issueSignedToken + presignUrl로
// 창고 문을 연 뒤, 그 응답 본문만 우리 API가 그대로 흘려 보낸다(2026-09-15 D).
// validUntil은 "학생이 링크를 누를 수 있는 창"이 아니라, 서버가 파일을 받아 넘기는 시간이다.

export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const BLOB_FETCH_WINDOW_MS = 60 * 60 * 1000;

export function blobStoreConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_OIDC_TOKEN);
}

async function presignedBlobUrl(pathname: string, operation: "get" | "head"): Promise<string> {
  const token = await issueSignedToken({
    pathname,
    operations: [operation],
    validUntil: Date.now() + BLOB_FETCH_WINDOW_MS,
  });
  const { presignedUrl } = await presignUrl(token, {
    operation,
    pathname,
    access: "private",
    validUntil: Date.now() + BLOB_FETCH_WINDOW_MS,
  });
  return presignedUrl;
}

export async function headPrivateBlob(pathname: string): Promise<{
  contentType: string | null;
  contentLength: number | null;
}> {
  const url = await presignedBlobUrl(pathname, "head");
  const res = await fetch(url, { method: "HEAD" });
  if (!res.ok) {
    throw new Error("파일을 찾을 수 없습니다.");
  }
  const lengthHeader = res.headers.get("content-length");
  const contentLength = lengthHeader ? Number(lengthHeader) : null;
  if (contentLength !== null && (!Number.isFinite(contentLength) || contentLength < 0)) {
    throw new Error("파일 크기를 확인할 수 없습니다.");
  }
  if (contentLength !== null && contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error("파일 용량이 500MB를 넘습니다.");
  }
  return {
    contentType: res.headers.get("content-type"),
    contentLength,
  };
}

export async function getPrivateBlob(pathname: string): Promise<Response> {
  const url = await presignedBlobUrl(pathname, "get");
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error("파일을 받을 수 없습니다.");
  }
  return res;
}
