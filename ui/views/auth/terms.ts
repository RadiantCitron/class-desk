import { createClient } from "@/lib/supabase/server";
import { SERVICE_TERMS_TYPE, APPLICATION_PRIVACY_TERMS_TYPE, getCurrentTerms } from "@/lib/terms";
import type { TermsBlockView } from "./signup-complete";
import { runQuery } from "@/lib/commands/run-command";

export type TermsView =
  | { kind: "no-terms" }
  | {
      kind: "ok";
      /** agreeToTerms의 첫 인자(Screen이 bind한다). */
      termIds: { serviceTermsId: string; privacyTermsId: string };
      service: TermsBlockView;
      privacy: TermsBlockView;
    };

// 가입 시 서비스이용약관 + 개인정보수집이용동의를 별도 체크박스 2개로 받는다(국룰 — 개인정보보호법의 "포괄동의 금지" 원칙, 2026-09-11 확정·구현).
export async function loadTerms(): Promise<TermsView> {
  return runQuery({ command: "TERMS_VIEW" }, async () => {
    const supabase = await createClient();
    const serviceTerms = await getCurrentTerms(supabase, SERVICE_TERMS_TYPE);
    const privacyTerms = await getCurrentTerms(supabase, APPLICATION_PRIVACY_TERMS_TYPE);
    if (!serviceTerms || !privacyTerms) return { kind: "no-terms" };
    return {
      kind: "ok",
      termIds: { serviceTermsId: serviceTerms.id, privacyTermsId: privacyTerms.id },
      service: { version: serviceTerms.version, content: serviceTerms.content },
      privacy: { version: privacyTerms.version, content: privacyTerms.content },
    };
  });
}
