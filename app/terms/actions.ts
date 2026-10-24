"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/supabase/identity";
import { runCommand } from "@/lib/commands/run-command";
import { runAction, type ActionResult } from "@/lib/errors";

// 약관 동의 보충 — 이미 회원인 사람이 빠진 동의(예: 새 약관 버전)를 채운다. 새 가입은
// app/signup/actions.ts가 한다. 회원 행이 없으면(가입 미완료) 가입 마무리 화면으로 보낸다.
export async function agreeToTerms(
  params: { serviceTermsId: string; privacyTermsId: string },
  _prevState: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const profile = await getCurrentProfile();
    if (!profile) {
      redirect("/signup/complete");
    }

    await runCommand(
      { command: "TERMS_AGREE", targetTable: "terms_agreements" },
      async (actor) => {
        const supabase = await createClient();
        const { data: existingAgreements } = await supabase
          .from("terms_agreements")
          .select("terms_id")
          .eq("user_id", actor.id)
          .in("terms_id", [params.serviceTermsId, params.privacyTermsId]);

        const agreedIds = new Set(existingAgreements?.map((a) => a.terms_id));
        const missingIds = [params.serviceTermsId, params.privacyTermsId].filter((id) => !agreedIds.has(id));

        if (missingIds.length > 0) {
          const { error } = await supabase
            .from("terms_agreements")
            .insert(missingIds.map((terms_id) => ({ user_id: actor.id, terms_id })));
          if (error) {
            throw new Error(`약관 동의 처리 실패: ${error.message}`);
          }
        }
        return { result: null, targetId: actor.id, detail: { missingIds } };
      },
    );

    redirect(profile.role !== "STUDENT" ? "/admin" : "/student");
  });
}
