"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { runCommand } from "@/lib/commands/run-command";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";

// 약관 원문은 지금까지 마이그레이션 시드로만 등록할 수 있었다 — 관리자가 새 버전을 직접
// 등록할 수 있는 화면이 없었다(2026-09-11 "약관 체계" 확장의 일부로 함께 구현).
// 기존 버전은 절대 수정하지 않는다(append-only과 동일 원칙). "새 버전 등록"만
// 가능하고, 등록 즉시 effective_at이 가장 최신이면 getCurrentTerms()가 이걸 "현재 버전"으로
// 채택한다.
//
// 예상된 실패는 UserFacingError + runAction으로 감싼다.
export async function createTermsVersion(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const type = String(formData.get("type") ?? "");
    const version = String(formData.get("version") ?? "").trim();
    const content = String(formData.get("content") ?? "").trim();
    const change_summary = String(formData.get("change_summary") ?? "").trim();

    if (!type || !version || !content) {
      throw new UserFacingError("입력값이 올바르지 않습니다.");
    }
    if (!change_summary) {
      throw new UserFacingError("변경 사유(change_summary)를 반드시 입력해야 합니다.");
    }

    await runCommand({ command: "TERMS_VERSION_CREATE", targetTable: "terms" }, async () => {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from("terms")
        .insert({ type, version, content, change_summary })
        .select("id")
        .single();

      if (error) {
        throw new Error(`약관 등록 실패: ${error.message}`);
      }

      return { result: null, targetId: data.id, detail: { type, version } };
    });

    revalidatePath("/admin/terms");
  });
}
