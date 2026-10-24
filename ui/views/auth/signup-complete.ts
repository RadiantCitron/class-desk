import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentAuthUser, loadProfileByAuthUserId } from "@/lib/supabase/identity";
import {
  SERVICE_TERMS_TYPE,
  APPLICATION_PRIVACY_TERMS_TYPE,
  MARKETING_OPT_IN_TERMS_TYPE,
  getCurrentTerms,
} from "@/lib/terms";
import { runQuery } from "@/lib/commands/run-command";

export type TermsBlockView = { version: string; content: string };

export type SignupCompleteView =
  | { kind: "no-terms" }
  | {
      kind: "ok";
      /** completeSignup의 첫 인자(Screen이 bind한다). marketingTermsId는 선택 약관이 존재할 때만. */
      termIds: { serviceTermsId: string; privacyTermsId: string; marketingTermsId: string | null };
      service: TermsBlockView;
      privacy: TermsBlockView;
      marketing: TermsBlockView | null;
    };

// 가입 마무리 — 약관 2종 동의(+선택 1종). 매직링크 클릭으로 세션이 생긴 상태에서만 온다(원본 page와 같은 순서·같은 redirect).
export async function loadSignupComplete(): Promise<SignupCompleteView> {
  return runQuery({ command: "SIGNUP_COMPLETE_VIEW" }, async () => {
    const { supabase: authClient, user } = await getCurrentAuthUser();
    if (!user) {
      redirect("/signup");
    }
    if (await loadProfileByAuthUserId(authClient, user.id)) {
      redirect("/");
    }

    const supabase = await createClient();
    const serviceTerms = await getCurrentTerms(supabase, SERVICE_TERMS_TYPE);
    const privacyTerms = await getCurrentTerms(supabase, APPLICATION_PRIVACY_TERMS_TYPE);
    const marketingTerms = await getCurrentTerms(supabase, MARKETING_OPT_IN_TERMS_TYPE);

    if (!serviceTerms || !privacyTerms) {
      return { kind: "no-terms" };
    }

    return {
      kind: "ok",
      termIds: {
        serviceTermsId: serviceTerms.id,
        privacyTermsId: privacyTerms.id,
        marketingTermsId: marketingTerms?.id ?? null,
      },
      service: { version: serviceTerms.version, content: serviceTerms.content },
      privacy: { version: privacyTerms.version, content: privacyTerms.content },
      marketing: marketingTerms ? { version: marketingTerms.version, content: marketingTerms.content } : null,
    };
  });
}
