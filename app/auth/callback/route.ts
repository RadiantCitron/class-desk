import { NextResponse, type NextRequest } from "next/server";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadProfileByAuthUserId, loadProfileFromAuthClient } from "@/lib/supabase/identity";
import { addGuildMember } from "@/lib/discord/bot";
import { runCommand } from "@/lib/commands/run-command";
import { isUserFacingError } from "@/lib/errors";
import { recordIdentityLinkFailed } from "@/lib/member/record-identity-link-failed";

// 디스코드 연결·입장 인증 복귀 전용(2026-09-25 / 자동 입장은
// 2026-09-27). 가입·로그인은 매직링크라 app/auth/confirm/route.ts로 간다 — 이 경로엔 안 온다.
// 여기로 오는 정상 경우는 하나뿐이다:
//   ?next=link-discord — 로그인한 회원이 "디스코드 연결"을 눌렀다가 돌아옴
// 그 외(누가 공개 키로 디스코드 OAuth "로그인"을 직접 호출하고 돌아온 경우 등)는 로그아웃시키고 막는다 —
// "디스코드로 로그인하는 길은 없다"를 우리 쪽이 강제한다.
// 2026-09-27부터 여기서 discord_accounts 기록 뒤 디스코드 길드(서버) 자동 추가까지 시도한다
// (addGuildMember) — access_token은 지역 변수(providerToken)로만 쓰고 DB에 저장하지 않는다.
// 연결 실패는 account_events IDENTITY_LINK_FAILED — MEMBER 헬퍼 RPC만.
// 연결 기록~서버 입장은 명령 DISCORD_LINK다 — 연결 시작(app/student/profile/actions.ts)과 이 복귀가 같은 명령이다.
// 신원은 방금 확정한 세션이라 쿠키로 아직 안 보여서 identity로 넘긴다. 스위치로 막혀 있으면 연결 기록을 하지 않고 안내만 한다.
class LinkRedirect extends Error {
  constructor(readonly path: string) {
    super(path);
  }
}

const LINK_ERROR_MESSAGES: Record<string, string> = {
  identity_already_exists: "discord_in_use",
};

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next");
  const errorCode = searchParams.get("error_code");

  // cookies()로만 심고 NextResponse.redirect()를 따로 만들면, Next 16에서 Set-Cookie가
  // 리다이렉트 응답에 안 붙는 경우가 있다(옛 콜백에서 겪은 문제 — 같은 방식 유지).
  const { supabase, redirectWithSession } = createRouteHandlerClient(request);

  if (errorCode) {
    const reason = LINK_ERROR_MESSAGES[errorCode] ?? "link_failed";
    // 연결 시도 전 이미 이메일 세션이 있으면 user id를 알 수 있다.
    const existing = await loadProfileFromAuthClient(supabase);
    if (existing && !existing.withdrawnAt) {
      await recordIdentityLinkFailed(existing.id, reason, errorCode);
    }
    return NextResponse.redirect(`${origin}/student/profile?link_error=${reason}`);
  }

  if (!code || next !== "link-discord") {
    return NextResponse.redirect(`${origin}/login?error=use_email_login`);
  }

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    // 세션이 없으면 users.id를 모른다 — IDENTITY_LINK_FAILED 기록 스킵.
    console.error("auth callback exchangeCodeForSession 실패:", error?.message);
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  const profile = await loadProfileByAuthUserId(supabase, data.user.id);
  if (!profile || profile.withdrawnAt) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  let nextPath: string;
  try {
    nextPath = await runCommand(
      { command: "DISCORD_LINK", targetTable: "users", target: { targetId: profile.id }, identity: { actor: profile } },
      async () => {
        // identity_data.sub가 디스코드 ID다(2026-09-10 실제 로그인으로 검증한 필드).
        const discordId = (
          data.user.identities?.find((identity) => identity.provider === "discord")?.identity_data as
            | { sub?: string }
            | undefined
        )?.sub;
        if (!discordId) {
          await recordIdentityLinkFailed(profile.id, "missing_sub", "discord identity sub 없음");
          throw new LinkRedirect("/student/profile?link_error=link_failed");
        }

        const admin = createAdminClient();
        const { error: linkError } = await admin.rpc("link_discord_identity", {
          p_user_id: profile.id,
          p_discord_id: discordId,
        });
        if (linkError) {
          const reason = linkError.code === "23505" ? "discord_in_use" : "link_failed";
          await recordIdentityLinkFailed(profile.id, reason, linkError.message);
          throw new LinkRedirect(`/student/profile?link_error=${reason}`);
        }

        // 디스코드 서버 자동 추가(2026-09-27) — guilds.join scope로 받은 provider_token(=디스코드
        // access_token)을 이 요청 안에서만 쓰고 버린다. DB에는 절대 저장하지 않는다(합의 확정).
        // 실패해도 연결(위 RPC) 자체는 이미 성공했으니 막지 않고, 초대링크로 수동 입장하라고
        // 안내만 한다(dead_letters에 토큰 없이 기록만 남김). 길드 조인은 account_events 중복 기록 안 함.
        const providerToken = data.session.provider_token;
        try {
          if (!providerToken) {
            throw new Error("provider_token이 없습니다(guilds.join scope 동의 여부 확인 필요).");
          }
          await addGuildMember(discordId, providerToken);
        } catch (joinError) {
          await admin.from("dead_letters").insert({
            source: "DISCORD_GUILD_JOIN",
            payload: { user_id: profile.id, discord_id: discordId },
            error_message: joinError instanceof Error ? joinError.message : String(joinError),
          });
          return { result: "/student/profile?linked=1&join_error=1", detail: { join_error: true } };
        }

        return { result: "/student/profile?linked=1" };
      },
    );
  } catch (err) {
    if (err instanceof LinkRedirect) return redirectWithSession(err.path);
    // 레일이 막았다(스위치·역할) — 연결 기록은 하지 않았다.
    if (isUserFacingError(err)) return redirectWithSession("/student/profile?link_error=link_failed");
    throw err;
  }
  return redirectWithSession(nextPath);
}
