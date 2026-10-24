import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadProfileByAuthUserId, scrambleAuthPasswordInSession } from "@/lib/supabase/identity";
import { runCommand } from "@/lib/commands/run-command";
import { UserFacingError } from "@/lib/errors";
import type { Role } from "@/lib/auth/permissions";

// 가입 마무리(회원 행 생성)의 유일한 경로. 매직링크를 눌러 세션이 생긴 뒤에만 부른다.
// 진입점(L4) 계층의 공용 함수다 — 게이트·감사(CS)와 회원 RPC를 함께 엮으므로 업무 모듈(lib/member)에 둘 수 없다
// (업무 모듈은 CS를 import하지 않는다). 서버 액션 파일이 아니라 일반 모듈이라 "use server"가 없다.
// 예전엔 app/signup/actions.ts(completeSignup)와 app/auth/confirm(자동 가입, 2026-10-06 추가)에 따로 있었고,
// 자동 쪽에 아래 ②③이 빠져 계정 탈취 방어(G-T1/T1b)가 회귀했다. 두 진입점은 이제 이 함수만 부른다.
//
//  ① 이메일로 가입한 인증 계정인지(email identity) — 아니면 세션을 끊고 거부
//  ② 심어 둔 비밀번호 2차 무력화 + 다른 세션 로그아웃(T1b: 링크 요청 "뒤에" 공격자가 signUp(password)한 경우)
//  ③ complete_signup() — 회원 행·약관 동의를 한 트랜잭션으로(DB가 게이트·약관 ID를 다시 검증)
// 전체가 명령 ACCOUNT_SIGNUP 하나다 — 가입 봉쇄(시스템·회원 모듈·ACCOUNT_SIGNUP 스위치)는 레일이 시작 지점에서 막고,
// 감사는 가입 전엔 행위자가 없어 ATTEMPTED 없이 성공만 남긴다(행위자 = 새 users.id, 기존 관례). 신원은 호출부가 이미 안다:
// 이 시점엔 회원 행이 없고, route handler(/auth/confirm)에선 방금 확정한 세션이 쿠키로 아직 안 보이므로 identity로 null을 넘긴다.
export type SignupTerms = {
  serviceTermsId: string;
  privacyTermsId: string;
  marketingTermsId: string | null;
};

export type FinishSignupResult =
  | { kind: "CREATED"; profileId: string }
  // 같은 세션으로 가입이 동시에 두 번 들어와(중복 클릭·링크 재클릭) 이미 회원 행이 있는 경우
  | { kind: "ALREADY_MEMBER"; role: Role };

export async function finishSignup(
  supabase: SupabaseClient,
  user: User,
  terms: SignupTerms,
): Promise<FinishSignupResult> {
  return runCommand<"ACCOUNT_SIGNUP", FinishSignupResult>({ command: "ACCOUNT_SIGNUP", targetTable: "users", identity: { actor: null } }, async () => {
    if (!user.identities?.some((identity) => identity.provider === "email")) {
      await supabase.auth.signOut();
      throw new UserFacingError("이메일로 가입한 계정만 회원이 될 수 있습니다. 처음부터 다시 가입해 주세요.");
    }

    await scrambleAuthPasswordInSession(supabase);
    await supabase.auth.signOut({ scope: "others" });

    const admin = createAdminClient();
    const { data: newProfileId, error } = await admin.rpc("complete_signup", {
      p_auth_user_id: user.id,
      p_email: user.email ?? "",
      p_service_terms_id: terms.serviceTermsId,
      p_privacy_terms_id: terms.privacyTermsId,
      p_marketing_terms_id: terms.marketingTermsId,
    });

    if (error) {
      // 23505 — 이 세션으로 가입이 동시에 두 번 요청됨 또는 이메일 유니크 충돌.
      if (error.code === "23505") {
        const raceProfile = await loadProfileByAuthUserId(admin, user.id);
        if (raceProfile) return { result: { kind: "ALREADY_MEMBER", role: raceProfile.role } };
        throw new UserFacingError("이미 가입된 이메일입니다. 로그인해 주세요.");
      }
      throw new Error(`가입 처리 실패: ${error.message}`);
    }

    const termsIds = [terms.serviceTermsId, terms.privacyTermsId, terms.marketingTermsId].filter(
      (id): id is string => id !== null,
    );
    return {
      result: { kind: "CREATED", profileId: newProfileId as string },
      actorProfileId: newProfileId as string,
      targetId: newProfileId as string,
      detail: { termsIds },
    };
  });
}
