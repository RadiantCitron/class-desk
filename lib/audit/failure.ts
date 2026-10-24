import { createAdminClient } from "@/lib/supabase/admin";
import type { AuditRecord } from "./types";

// 감사 기록 자체가 실패했을 때 그 사실을 관리자가 볼 수 있는 곳(DLQ)에 남긴다.
//
// 이 파일은 lib/audit/index.ts를 import하지 않는다 — recordAudit()이 실패를 이 함수로
// 보고하는데, 이 함수가 다시 recordAudit()을 부르면 감사 실패를 감사하려다 또 실패하는
// 무한 루프가 생긴다. import 방향 자체를 막아 구조적으로 차단한다(audit.guard.test.ts로 고정).
export async function reportAuditFailure(record: AuditRecord, err: unknown): Promise<void> {
  const errorMessage = err instanceof Error ? err.message : String(err);

  try {
    const admin = createAdminClient();

    // lib/integrity/checks.ts의 checkStalePendingEnrollments()와 같은 원칙 — 관리자가
    // 확인하기 전까지, 같은 action의 미해결 경고가 이미 있으면 중복으로 쌓지 않는다. 감사
    // sink 자체가 죽은 동안 요청마다 DLQ 행이 폭주하는 걸 막기 위함이다.
    const { data: existing } = await admin
      .from("dead_letters")
      .select("id")
      .eq("source", "AUDIT")
      .eq("resolved", false)
      .contains("payload", { action: record.action })
      // limit(1) 없이 maybeSingle()을 쓰면 같은 경고가 2건 이상일 때 에러로 null이 돌아와
      // "없음"으로 판단하고 매번 1건씩 더 쌓인다.
      .limit(1)
      .maybeSingle();

    if (existing) return;

    await admin.from("dead_letters").insert({
      source: "AUDIT",
      payload: {
        action: record.action,
        targetTable: record.targetTable,
        targetId: record.targetId ?? null,
        targetRef: record.targetRef ?? null,
        phase: record.phase,
        correlationId: record.correlationId ?? null,
      },
      error_message: `감사로그 기록 실패(action=${record.action}): ${errorMessage}`,
    });
  } catch (dlqError) {
    // DLQ 적재 자체가 실패하면 더는 방법이 없다 — 콘솔에만 남기고 조용히 끝낸다. 감사
    // 실패 보고의 실패까지 업무를 막으면 안 된다는 원칙(fail-open)의 마지막 방어선이다.
    console.error("감사 실패 보고(DLQ 적재)마저 실패:", dlqError);
  }
}
