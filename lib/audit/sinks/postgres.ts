import { createAdminClient } from "@/lib/supabase/admin";
import type { AuditRecord, AuditSink } from "../types";

// audit_logs에 실제로 쓰는 유일한 곳. 이 파일 밖에서 audit_logs에 직접 insert하지 않는다
// (audit.guard.test.ts가 구조로 강제한다).
//
// 실패하면 그대로 throw한다 — fail-open 여부는 이 sink의 책임이 아니라 lib/audit/index.ts의
// recordAudit()이 결정한다(포트/어댑터 분리 원칙: sink는 "어떻게 저장하는지"만 알고, "저장이
// 실패하면 어떻게 할지"는 모른다).
export const postgresSink: AuditSink = {
  name: "postgres",

  async write(record: AuditRecord): Promise<void> {
    const admin = createAdminClient();
    const { error } = await admin.from("audit_logs").insert({
      actor_user_id: record.actorProfileId,
      action: record.action,
      target_table: record.targetTable,
      target_id: record.targetId ?? null,
      target_ref: record.targetRef ?? null,
      detail: record.detail ?? {},
      phase: record.phase,
      correlation_id: record.correlationId,
    });

    if (error) {
      throw new Error(`감사로그 기록 실패: ${error.message}`);
    }
  },
};
