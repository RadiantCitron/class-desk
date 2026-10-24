"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { runCommand } from "@/lib/commands/run-command";
import { runOutboxBatch } from "@/lib/wiring/outbox";
import { GATE_CODES } from "@/lib/system/gates";
import { setRailSwitch, clearRailSwitchById } from "@/lib/commands/switches";
import { parseSwitchKey } from "@/lib/commands/switch-input";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";

// 통제 스위치 관리 — 설정·해제 모두 공리 명령 RAIL_SWITCH_SET 하나다(detail.op로 구분). 레일에는 관리자 면제가
// 없어서, 스위치를 켜고 끄는 명령이 스위치에 걸리면 아무도 풀 수 없다 — 그래서 이 명령만 스위치로 막히지 않는다(통제실 통로).
// 역할은 등록부 who(ADMIN)가 본다. 사유는 설정·해제 둘 다 필수다("관리자가 바꾸는 상태 전이는
// 방향과 무관하게 전부 사유 필수"). 옛 감사 이름 SYSTEM_GATE_SET·STUDENT_RESTRICTION_SET/_CLEAR 행은 이력으로 남는다.
//
// 예상된 실패는 UserFacingError + runAction으로 감싼다.

// "껐는데 안 꺼짐"을 막는다 — 스위치를 읽는 화면(학생·관리자 배너, 각 화면)이 다음 요청에서 바로 새 상태를 보도록 관련 경로를 함께 재검증한다.
function revalidateSwitchViews(): void {
  revalidatePath("/admin/system");
  revalidatePath("/admin/students");
  revalidatePath("/admin");
  revalidatePath("/student");
}

export async function setSwitch(_prevState: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const key = parseSwitchKey(String(formData.get("level") ?? ""), String(formData.get("target") ?? ""));
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      throw new UserFacingError("설정 사유를 입력해 주세요.");
    }
    const email = String(formData.get("userEmail") ?? "").trim().toLowerCase();

    await runCommand({ command: "RAIL_SWITCH_SET", targetTable: "rail_switches" }, async (adminProfile) => {
      // 유저를 비우면 전원 대상, 이메일을 적으면 그 회원 한 명 대상이다. 관리자·매니저도 대상이 될 수 있다(모든 유저는 같다).
      let userId: string | null = null;
      if (email) {
        const admin = createAdminClient();
        const { data: user } = await admin.from("users").select("id").eq("email", email).maybeSingle();
        if (!user) throw new UserFacingError("그 이메일의 회원을 찾을 수 없습니다.");
        userId = user.id;
      }

      const outcome = await setRailSwitch({ ...key, userId, reason, setBy: adminProfile.id });
      if (outcome === "ALREADY_SET") {
        throw new UserFacingError("같은 스위치가 이미 켜져 있습니다. 사유를 바꾸려면 먼저 해제하세요.");
      }
      return { result: null, targetId: userId, detail: { op: "SET", ...key, userId, reason } };
    });

    revalidateSwitchViews();
  });
}

export async function clearSwitch(
  switchId: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      throw new UserFacingError("해제 사유를 입력해 주세요.");
    }

    await runCommand({ command: "RAIL_SWITCH_SET", targetTable: "rail_switches", target: { targetId: switchId } }, async (adminProfile) => {
      const cleared = await clearRailSwitchById({ id: switchId, reason, clearedBy: adminProfile.id });
      // 이미 해제된 스위치를 다시 해제하려는 경우 — 0행 UPDATE가 조용히 "성공"으로 보이던 것을 막는다.
      if (cleared.outcome === "NOT_SET") {
        throw new UserFacingError("이미 해제된 스위치입니다. 화면을 새로고침한 뒤 다시 확인해 주세요.");
      }
      return {
        result: null,
        targetId: switchId,
        detail: { op: "CLEAR", level: cleared.level, target: cleared.target, userId: cleared.userId, reason },
      };
    });

    revalidateSwitchViews();
  });
}

// 감사 기록(AUDIT) on/off — 레일 스위치가 아니라 0층 스위치(lib/audit/switch.ts)라 system_gates 행을 바꾼다. 같은 공리 명령을 쓴다.
// 봉쇄(CLOSED)와 해제(OPEN)를 같은 함수로 다룬다. code는 GATE_CODES(AUDIT)만 받는다.
export async function setGate(
  code: string,
  status: "OPEN" | "CLOSED",
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    if (!(GATE_CODES as readonly string[]).includes(code)) {
      throw new UserFacingError(`알 수 없는 게이트 코드: ${code}`);
    }

    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      throw new UserFacingError(
        status === "CLOSED" ? "봉쇄 사유를 입력해 주세요." : "해제 사유를 입력해 주세요.",
      );
    }

    await runCommand({ command: "RAIL_SWITCH_SET", targetTable: "system_gates" }, async (adminProfile) => {
      const admin = createAdminClient();
      const { error } = await admin
        .from("system_gates")
        .update({
          status,
          reason,
          changed_by: adminProfile.id,
          changed_at: new Date().toISOString(),
        })
        .eq("code", code);

      if (error) {
        throw new Error(`상태 변경 실패: ${error.message}`);
      }

      // audit_logs.target_id는 uuid 컬럼이다 — code는 text라 detail(jsonb)에만 넣는다(2026-09-20).
      return { result: null, targetId: null, detail: { op: status === "CLOSED" ? "SET" : "CLEAR", code, status, reason } };
    });

    revalidatePath("/admin/system");
  });
}

// 대시보드 렌더에서 뺀 드레인을 관리자가 원할 때 실행하는 명시적 경로.
export async function manualDrainOutbox(
  _prevState: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await runCommand({ command: "OUTBOX_DRAIN_MANUAL", targetTable: "outbox_messages" }, async () => {
      const result = await runOutboxBatch();
      return { result: null, targetId: null, detail: result };
    });

    revalidatePath("/admin");
    revalidatePath("/admin/dlq");
  });
}
