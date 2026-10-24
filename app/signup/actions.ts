"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import {
  getCurrentAuthUser,
  loadProfileByAuthUserId,
  neutralizePlantedPassword,
} from "@/lib/supabase/identity";
import { runCommand } from "@/lib/commands/run-command";
import { finishSignup } from "@/app/signup/finish-signup";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";

// 가입 — 이메일 매직링크 한 번(2026-09-25 재설계). 비밀번호 입력이 없다. 링크 요청과 가입 마무리는 같은 명령
// ACCOUNT_SIGNUP이다 — 가입이 끝나기 전엔 우리 users.id(감사 행위자)가 없어 기록은 마무리 성공 때만 남는다
// (app/signup/finish-signup.ts). 가입 봉쇄는 통제 스위치(회원 모듈·ACCOUNT_SIGNUP·시스템 전원)가 레일에서 막는다.

function normalizeEmail(raw: FormDataEntryValue | null): string {
  return String(raw ?? "").trim().toLowerCase();
}

// 이메일로 가입 링크 보내기
export async function sendSignupLink(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const email = normalizeEmail(formData.get("email"));
    if (!email.includes("@")) {
      throw new UserFacingError("이메일 주소를 확인해 주세요.");
    }
    
    const serviceAgreed = formData.get("service_agreed") === "on";
    const privacyAgreed = formData.get("privacy_agreed") === "on";
    const marketingOptedIn = formData.get("marketing_opt_in") === "on";

    if (!serviceAgreed || !privacyAgreed) {
      throw new UserFacingError("필수 약관에 동의해야 합니다.");
    }

    await runCommand({ command: "ACCOUNT_SIGNUP", targetTable: "users" }, async () => {
      // 누가 미리 이 이메일로 signUp(password)을 직접 불러 심어 둔 비밀번호가 있으면 무력화한다
      // 이미 확인된 계정이면 안내만 하고 끝낸다.
      const state = await neutralizePlantedPassword(email);
      if (state === "CONFIRMED") {
        throw new UserFacingError("이미 가입된 이메일입니다. 로그인해 주세요.");
      }

      const origin = (await headers()).get("origin") ?? "http://127.0.0.1:3000";
      const supabase = await createClient();
    
      const pendingAgreements = ["SERVICE_USE", "PRIVACY_USE"];
      if (marketingOptedIn) {
        pendingAgreements.push("MARKETING_OPT_IN");
      }

      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { 
          shouldCreateUser: true, 
          emailRedirectTo: `${origin}/auth/confirm`,
          data: {
            pending_agreements: pendingAgreements
          }
        },
      });
      if (error) {
        throw new UserFacingError(`가입 링크를 보내지 못했습니다: ${error.message}`);
      }
      return { result: undefined };
    });
    redirect(`/signup?sent=${encodeURIComponent(email)}`);
  });
}

// 약관 동의 → 회원 행 생성. 매직링크를 클릭해 세션이 생긴 뒤에만 온다.
//
// marketingTermsId는 그 약관이 지금 존재하는지만 나타낸다(화면에 보여줄지 여부) — 실제
// 동의 여부는 폼의 marketing_opt_in 체크박스(formData)로 판단한다. 안 눌렀으면
// complete_signup()에 null을 넘겨 "동의 안 함"으로 저장한다(선택 동의, 2026-09-26 구조 분리).
export async function completeSignup(
  params: { serviceTermsId: string; privacyTermsId: string; marketingTermsId: string | null },
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, user } = await getCurrentAuthUser();
    if (!user) {
      redirect("/signup");
    }
    if (await loadProfileByAuthUserId(supabase, user.id)) {
      redirect("/");
    }
    // 가입 마무리 본체는 app/signup/finish-signup.ts 한 곳 — /auth/confirm 자동 가입과 같은 경로.
    const marketingOptedIn = formData.get("marketing_opt_in") === "on";
    const outcome = await finishSignup(supabase, user, {
      serviceTermsId: params.serviceTermsId,
      privacyTermsId: params.privacyTermsId,
      marketingTermsId: marketingOptedIn ? params.marketingTermsId : null,
    });
    if (outcome.kind === "ALREADY_MEMBER") {
      redirect(outcome.role !== "STUDENT" ? "/admin" : "/student");
    }

    redirect("/student?welcome=1");
  });
}
