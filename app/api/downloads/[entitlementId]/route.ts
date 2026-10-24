import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runCommand } from "@/lib/commands/run-command";
import { isUserFacingError } from "@/lib/errors";
import {
  contentDispositionAttachment,
  downloadFilename,
  parseBlobPathname,
} from "@/lib/downloads/pathname";
import { getPrivateBlob, headPrivateBlob, blobStoreConfigured } from "@/lib/downloads/privateBlob";

// 학생은 /api/downloads/{권한id} 만 본다. Blob 주소는 응답 헤더/본문에 넣지 않는다.
// 클릭 1번 = consume_entitlement() 1회. 같은 주소로 다시 GET하면 횟수가 남아 있을 때만 된다.
// 명령 ENTITLEMENT_DOWNLOAD다 — 신원·통제 스위치·역할은 runCommand가 보고, 감사(시도·성공·실패)도 거기서 남긴다.
// 이 파일은 감사를 직접 쓰지 않는다. 실패는 DownloadError로 던져 runCommand가 FAILED로 남기고, 아래 GET이 HTTP 응답으로 바꾼다.

export const maxDuration = 300;

// HTTP 상태를 함께 실어 던지는 실패 — runCommand가 FAILED로 기록하고 GET이 응답으로 바꾼다.
class DownloadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function errorResponse(message: string, status: number) {
  return new NextResponse(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}

function statusForMessage(message: string): number {
  if (message === "로그인이 필요합니다.") return 401;
  // 통제 스위치(시스템·모듈·명령, 전원·본인)가 막은 경우 — lib/commands/rail.ts의 문구
  if (message.includes("일시 중단되었습니다") || message.includes("제한되었습니다")) return 403;
  if (message.startsWith("이용 제한 상태를 확인할 수 없어")) return 503;
  if (
    message === "탈퇴한 계정입니다." ||
    message === "디스코드에서 이메일 인증을 해야 합니다." ||
    message === "본인의 권한이 아닙니다." ||
    message === "회수된 권한입니다."
  ) {
    return 403;
  }
  if (message === "권한을 찾을 수 없습니다." || message === "파일을 찾을 수 없습니다.") return 404;
  if (
    message === "기간이 만료된 권한입니다." ||
    message === "사용 가능 횟수를 모두 사용했습니다." ||
    message === "파일이 아직 준비되지 않았습니다."
  ) {
    return 409;
  }
  if (message === "파일 용량이 500MB를 넘습니다.") return 413;
  if (message === "파일 저장소가 아직 연결되지 않았습니다.") return 503;
  return 400;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ entitlementId: string }> },
) {
  const { entitlementId } = await context.params;

  try {
    return await runCommand(
      { command: "ENTITLEMENT_DOWNLOAD", targetTable: "entitlements", target: { targetId: entitlementId } },
      async (profile) => {
        const admin = createAdminClient();
        const { data: entitlement, error: fetchError } = await admin
          .from("entitlements")
          .select("id, user_id, type, metadata")
          .eq("id", entitlementId)
          .maybeSingle();

        if (fetchError || !entitlement) {
          throw new DownloadError("권한을 찾을 수 없습니다.", 404);
        }
        if (entitlement.user_id !== profile.id) {
          throw new DownloadError("본인의 권한이 아닙니다.", 403);
        }
        if (entitlement.type !== "SOURCE_DOWNLOAD") {
          throw new DownloadError("다운로드 권한이 아닙니다.", 400);
        }

        const rawPath = (entitlement.metadata as { blob_pathname?: unknown } | null)?.blob_pathname;
        if (typeof rawPath !== "string" || !rawPath.trim()) {
          throw new DownloadError("파일이 아직 준비되지 않았습니다.", 409);
        }

        if (!blobStoreConfigured()) {
          throw new DownloadError("파일 저장소가 아직 연결되지 않았습니다.", 503);
        }

        let pathname: string;
        let filename: string;
        try {
          pathname = parseBlobPathname(rawPath);
          filename = downloadFilename(pathname);
        } catch (err) {
          throw new DownloadError(err instanceof Error ? err.message : "파일 경로가 올바르지 않습니다.", 400);
        }

        try {
          await headPrivateBlob(pathname);
        } catch (err) {
          const message = err instanceof Error ? err.message : "파일을 찾을 수 없습니다.";
          const mapped = statusForMessage(message);
          throw new DownloadError(message, mapped === 400 ? 502 : mapped);
        }

        const forwarded = request.headers.get("x-forwarded-for");
        const ip = forwarded?.split(",")[0]?.trim().slice(0, 64) ?? null;
        const userAgent = request.headers.get("user-agent")?.slice(0, 512) ?? null;

        // Blob 저장소에서 실제로 응답(헤더+본문 스트림)을 받아오는 데 성공한 뒤에야 사용 횟수를
        // 차감한다(순서를 뒤집음, 2026-09-26) — 이전엔 차감이 먼저였어서, 이 fetch가 실패하면
        // "횟수는 줄었는데 파일은 못 받음" 상태가 됐다).
        // 단, fetch()가 성공(res.ok)으로 끝나는 시점은 응답 헤더가 도착한
        // 시점이지 본문 전체가 다 전달됐다는 뜻은 아니다 — 여기서부터 브라우저까지 스트리밍하는
        // 구간(우리 서버 밖)의 실패는 이 순서를 바꿔도 여전히 감지 못 한다(구조적 한계, 사용자
        // 확인 완료 — 클라이언트 확인 콜백 없이는 불가능해 이번 범위에서 안 함).
        // Blob 쪽 장애가 반복되는지 관리자가 나중에 조회할 수 있도록 이 실패도 runCommand가 FAILED로 남긴다(사용 횟수는 안 깎였다).
        let blobRes;
        try {
          blobRes = await getPrivateBlob(pathname);
        } catch (err) {
          throw new DownloadError(err instanceof Error ? err.message : "파일을 받을 수 없습니다.", 502);
        }

        const { error: consumeError } = await admin.rpc("consume_entitlement", {
          p_entitlement_id: entitlementId,
          p_user_id: profile.id,
          p_ip: ip,
          p_user_agent: userAgent,
        });

        if (consumeError) {
          const message = consumeError.message || "권한을 사용할 수 없습니다.";
          throw new DownloadError(message, statusForMessage(message));
        }

        // 유료 자료가 실제로 반출된 시점이 runCommand의 SUCCEEDED 행이다. 기록이 실패해도 파일 반출은
        // 계속 진행된다(recordAudit은 throw하지 않는다 — fail-open).
        return {
          result: new NextResponse(blobRes.body, {
            status: 200,
            headers: {
              "Content-Type": blobRes.headers.get("content-type") || "application/octet-stream",
              "Content-Disposition": contentDispositionAttachment(filename),
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
          }),
          detail: { pathname },
        };
      },
    );
  } catch (err) {
    if (err instanceof DownloadError) return errorResponse(err.message, err.status);
    // 레일이 막았다(로그인·탈퇴·스위치·역할) — 문구를 그대로 쓰고 상태는 문구로 정한다.
    if (isUserFacingError(err)) return errorResponse(err.message, statusForMessage(err.message));
    throw err;
  }
}
