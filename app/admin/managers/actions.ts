"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { runCommand } from "@/lib/commands/run-command";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";

// 매니저 CRUD는 전부 ADMIN 전용이다(등록부 who: "ADMIN"). 매니저는 "생성"이 아니라 "이미 가입한
// 회원을 승격"이다 — 회원은 스스로 이메일로 가입한다 — 사이트가
// 계정을 대신 만들지 않는다. 디스코드 연결 여부는 매니저 자격과 무관하다(2026-09-25).
// set_manager()/revoke_manager()(DB 함수)가 실제 승격·박탈
// 로직을 원자적으로 수행하고, 여기서는 입력값을 정리해 넘기고 감사로그를 남기는 역할만 한다.
//
// 예상된 실패는 UserFacingError + runAction으로 감싼다.

function parsePermissions(formData: FormData) {
  return {
    view: formData.get("can_view_students") === "on",
    approve: formData.get("can_approve_orders") === "on",
    pay: formData.get("can_approve_payments") === "on",
  };
}

export async function grantManager(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    if (!email) {
      throw new UserFacingError("이메일을 입력해 주세요.");
    }
    const { view, approve, pay } = parsePermissions(formData);

    await runCommand({ command: "MANAGER_GRANT", targetTable: "manager_permissions" }, async (adminProfile) => {
      const admin = createAdminClient();

      const { data: target, error: findError } = await admin
        .from("users")
        .select("id, role")
        .eq("email", email)
        .maybeSingle();

      if (findError) throw new Error(`대상 조회 실패: ${findError.message}`);
      if (!target) {
        throw new UserFacingError(
          "해당 이메일로 가입한 회원을 찾을 수 없습니다. 먼저 가입해야 매니저로 지정할 수 있습니다.",
        );
      }

      const { error } = await admin.rpc("set_manager", {
        p_target: target.id,
        p_actor: adminProfile.id,
        p_view: view,
        p_approve: approve,
        p_pay: pay,
      });
      if (error) throw new Error(`매니저 지정 실패: ${error.message}`);

      return {
        result: null,
        targetId: target.id,
        detail: { email, view, approve, pay, previous_role: target.role },
      };
    });

    revalidatePath("/admin/managers");
    revalidatePath("/admin");
  });
}

export async function updateManagerPermissions(
  userId: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const { view, approve, pay } = parsePermissions(formData);

    await runCommand({ command: "MANAGER_UPDATE", targetTable: "manager_permissions" }, async (adminProfile) => {
      const admin = createAdminClient();
      const { error } = await admin.rpc("set_manager", {
        p_target: userId,
        p_actor: adminProfile.id,
        p_view: view,
        p_approve: approve,
        p_pay: pay,
      });
      if (error) throw new Error(`매니저 권한 수정 실패: ${error.message}`);

      return { result: null, targetId: userId, detail: { view, approve, pay } };
    });

    revalidatePath("/admin/managers");
    revalidatePath("/admin");
  });
}

export async function revokeManager(
  userId: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      throw new UserFacingError("박탈 사유를 입력해 주세요.");
    }

    await runCommand({ command: "MANAGER_REVOKE", targetTable: "manager_permissions" }, async (adminProfile) => {
      const admin = createAdminClient();
      const { error } = await admin.rpc("revoke_manager", {
        p_target: userId,
        p_reason: reason,
        p_actor: adminProfile.id,
      });
      if (error) throw new Error(`매니저 박탈 실패: ${error.message}`);

      return { result: null, targetId: userId, detail: { reason } };
    });

    revalidatePath("/admin/managers");
    revalidatePath("/admin");
  });
}
