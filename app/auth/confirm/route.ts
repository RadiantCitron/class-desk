import { NextResponse, type NextRequest } from "next/server";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";
import { loadProfileByAuthUserId } from "@/lib/supabase/identity";
import { runCommand } from "@/lib/commands/run-command";
import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  APPLICATION_PRIVACY_TERMS_TYPE,
  MARKETING_OPT_IN_TERMS_TYPE,
  SERVICE_TERMS_TYPE,
  getCurrentTerms,
} from "@/lib/terms";
import { finishSignup } from "@/app/signup/finish-signup";

// verifyOtp가 받는 타입 중 우리가 실제로 보내는 것만 화이트리스트로 좁힌다(임의 문자열을
// 그대로 넘기지 않는다). email/signup/magiclink는 가입·로그인, email_change는 이메일 변경
// 확인.
const ALLOWED_OTP_TYPES = new Set(["email", "signup", "magiclink", "email_change"]);

// 이메일 매직링크(가입·로그인 공용) 복귀 지점(2026-09-25 재설계
// 비밀번호 없이 링크 클릭 한 번으로 끝난다). 회원 행이 없으면 처음 온 사람(가입 마무리로),
// 있으면 로그인 처리다. 로그인 확정은 명령 LOGIN(통제실 통로, 스위치로 막히지 않는다)이고, 신원은 방금 확정한
// 세션이라 쿠키로 아직 안 보여서 identity로 넘긴다. 가입 마무리는 finishSignup(명령 ACCOUNT_SIGNUP)이다.
//
// token_hash(+type)와 code(PKCE) 둘 다 받는다 — token_hash가 있으면 그쪽을 쓴다.
// PKCE의 code_verifier는 링크를 요청한 브라우저의 쿠키에만 있어 다른 기기(휴대폰 메일앱 등)에서
// 열면 실패했다.
// token_hash는 그 제약이 없다. code 경로는 옛 링크·하위 호환으로 남긴다.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const otpType = searchParams.get("type");

  if (!code && !tokenHash) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const { supabase, redirectWithSession } = createRouteHandlerClient(request);

  let userId: string | undefined;
  let authUser: User | null = null;

  if (tokenHash) {
    if (!otpType || !ALLOWED_OTP_TYPES.has(otpType)) {
      return NextResponse.redirect(`${origin}/login?error=auth_failed`);
    }
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: otpType as "email" | "signup" | "magiclink" | "email_change",
    });
    if (error || !data.user) {
      console.error("auth confirm verifyOtp 실패:", error?.message);
      return NextResponse.redirect(`${origin}/login?error=auth_failed`);
    }
    userId = data.user.id;
    authUser = data.user;
  } else {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code!);
    if (error || !data.user) {
      console.error("auth confirm exchangeCodeForSession 실패:", error?.message);
      return NextResponse.redirect(`${origin}/login?error=auth_failed`);
    }
    userId = data.user.id;
    authUser = data.user;
  }

  const profile = await loadProfileByAuthUserId(supabase, userId);

  // 처음 온 사람 — 아직 우리 회원 행이 없다. 약관 동의를 마쳐야 가입이 끝난다.
  if (!profile) {
    // 가입 폼(/signup)에서 필수 약관에 체크하고 링크를 받은 경우 여기서 바로 가입을 마친다. 본체는
    // app/signup/finish-signup.ts 한 곳 — completeSignup(가입 마무리 화면)과 같은 방어(G-T1/T1b 2차 무력화·
    // 다른 세션 로그아웃·email identity·SIGNUP 게이트)를 그대로 거친다.
    // 어떤 이유로든 실패하면 가입 마무리 화면으로 보낸다 — 거기서 같은 함수가 오류를 화면에 보여 준다.
    const pending = (authUser?.user_metadata?.pending_agreements ?? []) as string[];
    if (authUser && pending.includes("SERVICE_USE") && pending.includes("PRIVACY_USE")) {
      try {
        const admin = createAdminClient();
        const serviceTerms = await getCurrentTerms(admin, SERVICE_TERMS_TYPE);
        const privacyTerms = await getCurrentTerms(admin, APPLICATION_PRIVACY_TERMS_TYPE);
        if (serviceTerms && privacyTerms) {
          const marketingTerms = pending.includes(MARKETING_OPT_IN_TERMS_TYPE)
            ? await getCurrentTerms(admin, MARKETING_OPT_IN_TERMS_TYPE)
            : null;
          const outcome = await finishSignup(supabase, authUser, {
            serviceTermsId: serviceTerms.id,
            privacyTermsId: privacyTerms.id,
            marketingTermsId: marketingTerms?.id ?? null,
          });
          if (outcome.kind === "ALREADY_MEMBER") {
            return redirectWithSession(outcome.role !== "STUDENT" ? "/admin" : "/student");
          }
          return redirectWithSession("/student?welcome=1");
        }
      } catch (err) {
        console.error("auth confirm 자동 가입 실패(가입 마무리 화면으로):", err instanceof Error ? err.message : err);
      }
    }

    return redirectWithSession("/signup/complete");
  }

  // 이메일 변경 확인(type=email_change)이든 평소 로그인이든, 여기서 auth 이메일과 우리
  // users.email이 다르면 동기화한다(동기화 지점은 이 라우트 한 곳뿐).
  // 실패해도(예: 다른 회원과 이메일 충돌) sync_my_email() 안에서 DLQ로 남기고 조용히
  // 끝나므로 로그인 자체를 막지 않는다.
  const { error: syncError } = await supabase.rpc("sync_my_email");
  if (syncError) {
    console.error("이메일 동기화 실패(로그인은 계속 진행):", syncError.message);
  }

  // 탈퇴한 계정 — 세션은 유지한 채 복구 화면으로. LOGIN 게이트
  // 확인보다 먼저 본다 — 순서가 반대면 게이트가 닫혀 있을 때 탈퇴 계정이 "로그인 봉쇄"
  // 메시지만 보고 자기가 탈퇴 상태라는 걸 전혀 모르게 된다.
  if (profile.withdrawnAt) {
    return redirectWithSession("/reactivate");
  }

  // 로그인은 통제 스위치로 막지 않는다(LOGIN은 통제실 통로 — 막으면 관리자도 못 들어와 스위치를 되돌릴 수 없다).
  // 시스템 봉쇄(SYSTEM 스위치)는 로그인 "뒤"의 모든 명령·조회가 막는 것으로 대신한다(옛 「로그인 봉쇄 → 강제 로그아웃」은 없어졌다).
  await runCommand(
    { command: "LOGIN", targetTable: "users", target: { targetId: profile.id }, identity: { actor: profile } },
    async () => ({ result: undefined }),
  );

  if (profile.pendingTerms && profile.pendingTerms.length > 0) {
    return redirectWithSession(profile.role !== "STUDENT" ? "/admin" : "/student/welcome");
  }

  return redirectWithSession(profile.role !== "STUDENT" ? "/admin" : "/student");
}
