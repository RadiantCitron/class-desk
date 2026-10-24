"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runCommand } from "@/lib/commands/run-command";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";

// 예상된 실패(DB 에러)도 UserFacingError + runAction으로 감싼다.
// 처리 사유는 필수다(예전 학생 제한 설정 액션과 같은 패턴 — 그 액션은 CR-7에서 스위치 화면 `setSwitch`로 대체됐다).
export async function resolveDeadLetter(
  failureId: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      throw new UserFacingError("처리 사유를 입력해 주세요.");
    }

    await runCommand({ command: "DEAD_LETTER_RESOLVE", targetTable: "dead_letters" }, async (adminProfile) => {
      const supabase = await createClient();
      const { error } = await supabase
        .from("dead_letters")
        .update({
          resolved: true,
          resolved_by: adminProfile.id,
          resolved_at: new Date().toISOString(),
          resolution_reason: reason,
        })
        .eq("id", failureId);

      if (error) {
        throw new Error(`처리 실패: ${error.message}`);
      }

      return { result: null, targetId: failureId, detail: { reason } };
    });

    revalidatePath("/admin/dlq");
    revalidatePath("/admin");
  });
}

// 최대 재시도를 넘겨 dead_at이 찍힌 아웃박스 메시지를 되살린다.
// payload.outbox_message_id가 있는 DLQ(source='OUTBOX')에서만 의미가 있다.
// 재시도 사유는 필수다.
export async function retryDeadOutboxMessage(
  outboxMessageId: string,
  failureId: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      throw new UserFacingError("재시도 사유를 입력해 주세요.");
    }

    await runCommand({ command: "OUTBOX_MESSAGE_RETRY", targetTable: "outbox_messages" }, async (adminProfile) => {
      // reset_dead_outbox_message는 SECURITY DEFINER + service_role 전용(1-2)이라 사용자 세션
      // (createClient())으로는 권한 오류가 난다 — createAdminClient()를 쓴다. dead_letters의
      // resolved 표시는 관리자 RLS 쓰기 정책이 있는 테이블이라 그대로 supabase(세션)로 해도
      // 되지만, 한 함수 안에서 클라이언트를 섞으면 헷갈리므로 admin으로 통일한다.
      const admin = createAdminClient();
      const { error } = await admin.rpc("reset_dead_outbox_message", {
        p_outbox_message_id: outboxMessageId,
      });
      if (error) {
        throw new UserFacingError(error.message);
      }

      const { error: resolveError } = await admin
        .from("dead_letters")
        .update({
          resolved: true,
          resolved_by: adminProfile.id,
          resolved_at: new Date().toISOString(),
          resolution_reason: reason,
        })
        .eq("id", failureId);
      if (resolveError) {
        throw new Error(`처리 실패: ${resolveError.message}`);
      }

      return { result: null, targetId: outboxMessageId, detail: { reason } };
    });

    revalidatePath("/admin/dlq");
    revalidatePath("/admin");
  });
}
