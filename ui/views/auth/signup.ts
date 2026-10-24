import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAuthUser } from "@/lib/supabase/identity";
import {
  SERVICE_TERMS_TYPE,
  APPLICATION_PRIVACY_TERMS_TYPE,
  MARKETING_OPT_IN_TERMS_TYPE,
  getCurrentTerms,
} from "@/lib/terms";
import { runQuery } from "@/lib/commands/run-command";

export type TermsBlockView = { version: string; content: string };

export type SignupView = 
  | { kind: "no-terms"; sentEmail: string | null }
  | { 
      kind: "ok";
      sentEmail: string | null;
      service: TermsBlockView;
      privacy: TermsBlockView;
      marketing: TermsBlockView | null;
    };

export async function loadSignup(input: { sent?: string }): Promise<SignupView> {
  return runQuery({ command: "SIGNUP_VIEW" }, async () => {
    const { user } = await getCurrentAuthUser();
    if (user) {
      redirect("/signup/complete");
    }
  
    // 로그아웃 방문자가 가입 전에 보는 화면이라 약관을 service_role로 읽는다 — terms의 읽기 정책이 로그인 사용자 전용(처음부터)이라
    // 세션 클라이언트(anon)로는 0건이 나와 화면이 「필수 약관이 설정되지 않았습니다」로 막혔다(2026-10-07 e2e에서 발견의
    // 가입 전 약관 UI부터 있던 결함). 읽기 전용이고 이 세 종류의 최신 본문만 가져온다(정책 자체는 바꾸지 않았다 — 설계 판단).
    const supabase = createAdminClient();
    const serviceTerms = await getCurrentTerms(supabase, SERVICE_TERMS_TYPE);
    const privacyTerms = await getCurrentTerms(supabase, APPLICATION_PRIVACY_TERMS_TYPE);
    const marketingTerms = await getCurrentTerms(supabase, MARKETING_OPT_IN_TERMS_TYPE);

    if (!serviceTerms || !privacyTerms) {
      return { kind: "no-terms", sentEmail: input.sent ? input.sent : null };
    }

    return { 
      kind: "ok", 
      sentEmail: input.sent ? input.sent : null,
      service: { version: serviceTerms.version, content: serviceTerms.content },
      privacy: { version: privacyTerms.version, content: privacyTerms.content },
      marketing: marketingTerms ? { version: marketingTerms.version, content: marketingTerms.content } : null,
    };
  });
}
