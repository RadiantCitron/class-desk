"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { runCommand } from "@/lib/commands/run-command";
import { runAction, UserFacingError, type ActionResult } from "@/lib/errors";

// 개정된 필수 약관 재동의. 쓰기 서버 액션은 CS 명령 파이프라인을 거친다(R6) — 감사 ATTEMPTED/결과,
// 가드(활성 회원)가 여기서 붙는다(2026-10-07. 예전엔 requireProfile + service_role insert로 관문 밖이었다).
// 쓰기는 학생 세션으로 한다 — terms_agreements "본인 동의 이력만 등록 가능" RLS가 본인 행만 허용한다
// (app/terms/actions.ts와 같은 방식).
export async function agreeToTermsAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await runCommand(
      { command: "TERMS_REAGREE", targetTable: "terms_agreements" },
      async (actor) => {
        const pending = actor.pendingTerms ?? [];
        for (const term of pending) {
          if (formData.get(`term_${term.type}`) !== "on") {
            throw new UserFacingError("모든 필수 약관에 동의해야 합니다.");
          }
        }

        const termsIds = pending.map((term) => term.terms_id);
        if (termsIds.length > 0) {
          const supabase = await createClient();
          const { error } = await supabase
            .from("terms_agreements")
            .insert(termsIds.map((terms_id) => ({ user_id: actor.id, terms_id })));
          // 23505 = 이미 동의한 버전(중복 제출) — 결과는 같으니 성공으로 본다.
          if (error && error.code !== "23505") {
            throw new Error(`약관 동의 처리 실패: ${error.message}`);
          }
        }
        return { result: null, targetId: actor.id, detail: { termsIds } };
      },
    );

    revalidatePath("/student", "layout");
    redirect("/student");
  });
}
