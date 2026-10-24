import { createAdminClient } from "@/lib/supabase/admin";

// 감사 on/off 상태를 읽는 유일한 곳. system_gates 테이블의 AUDIT 행을 직접 조회한다 —
// lib/system/gates.ts를 import하지 않는다. 예전에는 gates.ts가 감사(logAudit)를 import해서 여기서 gates.ts를 다시 가져오면
// 순환 의존이 생겼다(lib/audit → lib/system/gates → lib/audit). 명령 레일 CR-6(2026-10-07)에서 gates.ts가 이름표만 남아
// 지금은 그 순환이 없지만, 감사 상태는 레일 스위치가 아니라 0층 스위치라는 구분을 코드로 남기려고 이 방향(lib/audit이 gates를
// 모른다)을 그대로 둔다. audit.guard.test.ts가 이 방향을 강제한다.
//
// 이 조회는 특정 사용자에게 배너를 보여주려는 게 아니라 서버 내부 판단이라, React cache()도
// request-scoped 쿠키 클라이언트도 필요 없다 — admin 클라이언트로 바로 읽는다.
const AUDIT_GATE_CODE = "AUDIT";

// last-known-good — 조회 실패 시 직전 상태를 쓰고, 그것도 없으면 "기록한다"(true)로 폴백한다.
// 통제 스위치(lib/commands/switches.ts — 못 읽으면 닫힘)와는 폴백 방향이 반대다: 감사는 "못 남기는
// 쪽"이 더 큰 손실이므로, 상태를 모를 땐 일단 기록을 시도하는 쪽이 안전하다.
let lastKnownAuditEnabled: boolean | null = null;

export async function isAuditEnabled(): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("system_gates")
      .select("status")
      .eq("code", AUDIT_GATE_CODE)
      .maybeSingle();

    if (error || !data) {
      return lastKnownAuditEnabled ?? true;
    }

    const enabled = data.status !== "CLOSED";
    lastKnownAuditEnabled = enabled;
    return enabled;
  } catch {
    return lastKnownAuditEnabled ?? true;
  }
}
