"use server";

import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { runCommand } from "@/lib/commands/run-command";
import { runAction, type ActionResult } from "@/lib/errors";

// 탈퇴 계정 복구. 대상은 세션에서만 정한다 — 클라이언트가 보낸 id를
// 받지 않는다(남의 계정 복구 방지, 1-4-11 ⑥). 이용권·디스코드 역할은 되살리지 않는다.
export async function reactivate(
  params: { serviceTermsId: string; privacyTermsId: string },
  _prevState: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await runCommand(
      {
        // 탈퇴 계정만 실행할 수 있다 — 등록부 who: "WITHDRAWN"(레일이 「탈퇴한 계정이 아닙니다.」로 거부).
        command: "ACCOUNT_REACTIVATE",
        targetTable: "users",
      },
      async (actor) => {
        const admin = createAdminClient();
        const { error } = await admin.rpc("reactivate_user", {
          p_user_id: actor.id,
          p_service_terms_id: params.serviceTermsId,
          p_privacy_terms_id: params.privacyTermsId,
        });
        if (error) {
          throw new Error(`복구 실패: ${error.message}`);
        }
        return { result: null, targetId: actor.id };
      },
    );
    redirect("/");
  });
}
