"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { runCommand } from "@/lib/commands/run-command";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";

// 예상된 실패는 UserFacingError + runAction으로 감싼다.
export async function createDiscountRule(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const name = String(formData.get("name") ?? "").trim();
    const discountType = String(formData.get("discount_type") ?? "");
    const discountValue = Number(formData.get("discount_value"));
    const description = String(formData.get("description") ?? "").trim() || null;
    const validFrom = String(formData.get("valid_from") ?? "") || null;
    const validUntil = String(formData.get("valid_until") ?? "") || null;

    if (!name || !["PERCENT", "FIXED"].includes(discountType) || !Number.isFinite(discountValue)) {
      throw new UserFacingError("입력값이 올바르지 않습니다.");
    }

    await runCommand({ command: "DISCOUNT_RULE_CREATE", targetTable: "discount_rules" }, async () => {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from("discount_rules")
        .insert({
          name,
          discount_type: discountType,
          discount_value: discountValue,
          description,
          valid_from: validFrom,
          valid_until: validUntil,
        })
        .select("id")
        .single();

      if (error) {
        throw new Error(`산정기준 생성 실패: ${error.message}`);
      }

      return { result: null, targetId: data.id, detail: { name, discountType, discountValue } };
    });

    revalidatePath("/admin/discount-rules");
  });
}

// 실제로는 지우지 않고 deleted_at만 세팅한다(courses/course_offerings와 동일한 원칙, 2026-09-11
// 확정). 이미 적용된 신청 건의 enrollments.discount_rule_id는 그대로 남는다(행 자체가 없어지지
// 않으므로 예전처럼 SET NULL로 끊을 필요가 없다 — final_amount는 원래도 스냅샷이라 상관없이
// 보존되고, discount_rule_id도 "그때 어떤 할인을 썼는지" 계속 추적 가능해 오히려 더 낫다).
// 신청건 존재 여부와 무관하게 항상 성공한다(과거의 ON DELETE SET NULL과 동일하게 막지 않음).
export async function deleteDiscountRule(
  ruleId: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      throw new UserFacingError("삭제 사유를 입력해 주세요.");
    }

    await runCommand({ command: "DISCOUNT_RULE_DELETE", targetTable: "discount_rules" }, async (adminProfile) => {
      const supabase = await createClient();
      const { error } = await supabase
        .from("discount_rules")
        .update({ deleted_at: new Date().toISOString(), deleted_reason: reason, deleted_by: adminProfile.id })
        .eq("id", ruleId);

      if (error) {
        throw new Error(`삭제 실패: ${error.message}`);
      }

      return { result: null, targetId: ruleId, detail: { reason } };
    });

    revalidatePath("/admin/discount-rules");
  });
}
