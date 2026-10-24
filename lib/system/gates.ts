// 옛 시스템 게이트 이름표 — 명령 레일 CR-6에서 판정 함수를, CR-7(2026-10-07)에서 PAYMENT·SIGNUP·LOGIN 이름표를 지웠다.
// 봉쇄·제한의 판정은 레일(lib/commands/rail.ts)이 통제 스위치(rail_switches)로 하고, 켜고 끄는 화면은 /admin/system의 스위치 화면 하나다.
//
// 남은 것은 AUDIT(감사 기록 on/off)뿐이다 — 레일 스위치가 아니라 0층 스위치(lib/audit/switch.ts)라 system_gates 테이블에 있다.
// GATE_CODES는 supabase/migrations의 system_gates 시드(옛 PAYMENT·SIGNUP·LOGIN 행은 이력으로 남아 있다)와 gates.guard.test.ts가 대조한다.
export const GATE_CODES = ["AUDIT"] as const;
export type GateCode = (typeof GATE_CODES)[number];

export const GATE_LABELS: Record<GateCode, string> = {
  AUDIT: "감사 기록",
};
