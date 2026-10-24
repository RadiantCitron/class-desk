import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActiveSwitch, SwitchLevel, SwitchSnapshot } from "./rail";

// 통제 스위치(rail_switches) 읽기·쓰기의 유일한 곳(ADR-0015). 쓰기는 공리 명령 RAIL_SWITCH_SET의 실행 함수(app/admin/system/actions.ts)만 부른다.
//
// 읽기는 fail-closed다 — 조회가 실패하면 { readable: false }를 돌려주고, 판정
// (lib/commands/rail.ts)은 통제실 통로(공리)만 빼고 전부 거부한다. 예전 게이트의 last-known-good·전부
// 열림 폴백은 쓰지 않는다. 대가: 이 조회가 깨지면 통로를 뺀 서비스 전체가 멈춘다.
//
// service_role로 읽는다 — 판정은 서버 내부 일이고(lib/audit/switch.ts와 같은 이유), proxy·route handler·
// 서버 액션·화면 어디서 불러도 같은 결과여야 하며, 비로그인(가입 화면)도 전원 대상 행을 봐야 한다.

type SwitchRow = {
  id: string;
  level: SwitchLevel;
  target: string | null;
  user_id: string | null;
  reason: string;
  set_at: string;
};

// 전원 대상 행 + (userId가 있으면) 그 유저 대상 행. userId는 우리 users.id(uuid)만 받는다.
export async function readRailSwitches(userId: string | null): Promise<SwitchSnapshot> {
  try {
    const admin = createAdminClient();
    let query = admin
      .from("rail_switches")
      .select("id, level, target, user_id, reason, set_at")
      .is("cleared_at", null);
    query = userId ? query.or(`user_id.is.null,user_id.eq.${userId}`) : query.is("user_id", null);
    const { data, error } = await query;
    if (error || !data) {
      console.error("통제 스위치 조회 실패(fail-closed):", error);
      return { readable: false };
    }
    const switches: ActiveSwitch[] = (data as SwitchRow[]).map((row) => ({
      id: row.id,
      level: row.level,
      target: row.target,
      userId: row.user_id,
      reason: row.reason,
      setAt: row.set_at,
    }));
    return { readable: true, switches };
  } catch (err) {
    console.error("통제 스위치 조회 실패(fail-closed):", err);
    return { readable: false };
  }
}

// RSC·서버 액션용 — 요청당 1회(React cache). proxy·route handler는 readRailSwitches를 직접 쓴다.
export const loadRailSwitches = cache(readRailSwitches);

export type SwitchKey = { level: SwitchLevel; target: string | null };

export async function setRailSwitch(input: SwitchKey & { userId: string | null; reason: string; setBy: string }): Promise<
  "SET" | "ALREADY_SET"
> {
  const admin = createAdminClient();
  const { error } = await admin.from("rail_switches").insert({
    level: input.level,
    target: input.target,
    user_id: input.userId,
    reason: input.reason,
    set_by: input.setBy,
  });
  if (error) {
    if (error.code === "23505") return "ALREADY_SET"; // rail_switches_active_uk
    throw new Error(`통제 스위치 설정 실패: ${error.message}`);
  }
  return "SET";
}

// 활성 스위치 하나를 id로 해제한다(삭제 없음 — 해제 시각·사유·행위자를 적는 UPDATE). 이미 해제됐으면 NOT_SET.
// 감사 기록에 남길 수 있게 해제된 행의 층·대상·유저를 돌려준다.
export async function clearRailSwitchById(input: { id: string; reason: string; clearedBy: string }): Promise<
  | { outcome: "CLEARED"; level: SwitchLevel; target: string | null; userId: string | null }
  | { outcome: "NOT_SET" }
> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("rail_switches")
    .update({ cleared_at: new Date().toISOString(), cleared_by: input.clearedBy, cleared_reason: input.reason })
    .eq("id", input.id)
    .is("cleared_at", null)
    .select("level, target, user_id");
  if (error) throw new Error(`통제 스위치 해제 실패: ${error.message}`);
  const row = data?.[0] as { level: SwitchLevel; target: string | null; user_id: string | null } | undefined;
  return row ? { outcome: "CLEARED", level: row.level, target: row.target, userId: row.user_id } : { outcome: "NOT_SET" };
}
