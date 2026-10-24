import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/supabase/identity";
import { runQuery } from "@/lib/commands/run-command";
import { SERVICE_TERMS_TYPE, APPLICATION_PRIVACY_TERMS_TYPE, getCurrentTerms } from "@/lib/terms";

export type ReactivateView =
  | { kind: "no-terms" }
  | {
      kind: "ok";
      /** reactivate의 첫 인자(Screen이 bind한다). */
      termIds: { serviceTermsId: string; privacyTermsId: string };
      serviceVersion: string;
      privacyVersion: string;
    };

// "탈퇴한 계정입니다. 복구하시겠습니까?". proxy.ts의 matcher 밖이라 이 화면이 직접 로그인·탈퇴 상태를 확인한다.
export async function loadReactivate(): Promise<ReactivateView> {
  const profile = await getCurrentProfile();
  if (!profile) {
    redirect("/login");
  }
  if (!profile.withdrawnAt) {
    redirect("/");
  }

  // 로그인·탈퇴 상태에 따른 이동은 화면 흐름이라 위에서 먼저 정한다. 여기부터는 통제 스위치(시스템·회원 모듈·이 화면 — 명령 레일 CR-5)를 본다.
  return runQuery({ command: "REACTIVATE_VIEW" }, async () => {
    const supabase = await createClient();
    const serviceTerms = await getCurrentTerms(supabase, SERVICE_TERMS_TYPE);
    const privacyTerms = await getCurrentTerms(supabase, APPLICATION_PRIVACY_TERMS_TYPE);
    if (!serviceTerms || !privacyTerms) return { kind: "no-terms" };
    return {
      kind: "ok",
      termIds: { serviceTermsId: serviceTerms.id, privacyTermsId: privacyTerms.id },
      serviceVersion: serviceTerms.version,
      privacyVersion: privacyTerms.version,
    };
  });
}
