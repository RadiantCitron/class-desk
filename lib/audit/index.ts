import { randomUUID } from "crypto";
import { postgresSink } from "./sinks/postgres";
import { noopSink } from "./sinks/noop";
import { isAuditEnabled } from "./switch";
import { reportAuditFailure } from "./failure";
import type { AuditRecord, AuditSink } from "./types";

export type { AuditRecord, AuditSink, AuditPhase } from "./types";

// 감사를 켜고 끄는 유일한 분기점. AUDIT 게이트가 CLOSED면 아무것도 안 하는 sink로 바꿔
// 끼운다 — 호출부(recordAudit)는 어느 쪽이 오든 똑같이 다룬다(어댑터 교체 지점).
export async function getAuditSink(): Promise<AuditSink> {
  const enabled = await isAuditEnabled();
  return enabled ? postgresSink : noopSink;
}

// 감사 기록의 유일한 입구. 절대 throw하지 않는다 — 호출부(업무 로직)는 감사가 되는지
// 신경 쓸 필요가 없다(fail-open). 기록 자체가 실패하면 조용히 사라지는 대신
// reportAuditFailure()로 DLQ에 남긴다.
//
// sink를 직접 넘기지 않으면 매번 새로 고른다(한 번만 쓰는 단발성 호출에 맞다 — 예전 gates.ts의 관리자 면제 기록
// GATE_BYPASS_ADMIN이 그랬고, 명령 레일 CR-6에서 없어졌다). 2단계 기록(ATTEMPTED→SUCCEEDED/FAILED)처럼 한 커맨드 안에서
// 여러 번 부를 때는 호출부(lib/commands/run-command.ts)가 getAuditSink()로 한 번만 고른
// sink를 넘겨야 한다 — 안 그러면 "AUDIT 게이트를 끄는 그 명령"의 결과 기록이, 실행이
// 끝난 시점엔 이미 감사가 꺼져 있어서 자기 자신을 못 남기는 모순이 생긴다(2026-09-20 실제
// e2e로 재현해 발견).
export async function recordAudit(record: AuditRecord, sink?: AuditSink): Promise<void> {
  const correlationId = record.correlationId ?? randomUUID();
  const full: AuditRecord = { ...record, correlationId };

  try {
    const resolvedSink = sink ?? (await getAuditSink());
    await resolvedSink.write(full);
  } catch (err) {
    await reportAuditFailure(full, err);
  }
}
