// 감사 기록 하나의 형태와, 그걸 실제로 저장하는 쪽(sink)의 계약.
//
// lib/payment/providers/types.ts(PaymentProvider)와 같은 형태를 그대로 따른다 — 인터페이스만
// 여기 두고, 구현체는 sinks/ 아래 객체 리터럴로 둔다. 클래스 계층을 쓰지 않는다.
export type AuditPhase = "ATTEMPTED" | "SUCCEEDED" | "FAILED";

export type AuditRecord = {
  actorProfileId: string;
  action: string;
  targetTable: string;
  // 대상이 uuid 행이면 targetId, uuid가 아닌 코드(예: system_gates.code)면 targetRef.
  // 2026-09-20에 겪은 uuid 타입 오류(text를 uuid 컬럼에 넣으려다 INSERT 자체가 실패)의
  // 구조적 해결책 — 호출부가 "이게 uuid인지 아닌지"를 타입으로 강제당한다.
  targetId?: string | null;
  targetRef?: string | null;
  detail?: Record<string, unknown>;
  phase: AuditPhase;
  // 같은 커맨드의 ATTEMPTED 행과 결과 행(SUCCEEDED/FAILED)을 묶는 값. 호출부가 안 넘기면
  // recordAudit()이 새로 발급한다(가입처럼 시도 기록이 없는 단발성 기록용).
  correlationId?: string;
};

export interface AuditSink {
  name: string;
  write(record: AuditRecord): Promise<void>;
}
