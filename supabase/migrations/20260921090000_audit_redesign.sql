-- 감사 모듈 재설계 1단계: 2단계 기록(phase)과 uuid 아닌 대상(target_ref), 그리고 감사 기록
-- 실패를 DLQ로 흘리기 위한 webhook_failures.source 확장.
-- 배경: (target_id uuid 타입 버그)(감사 구조 재검토).

-- =========================================================
-- 1. audit_logs: phase(2단계 기록) + correlation_id + target_ref
-- =========================================================
-- 기존 행을 UPDATE하지 않는다 — 한 커맨드가 ATTEMPTED 행 하나 + SUCCEEDED/FAILED 행 하나,
-- 총 2행을 INSERT하고 같은 correlation_id로 묶는다. UPDATE를 안 쓰는 이유는 다음 마이그레이션
-- (20260921100000)에서 audit_logs에 UPDATE/DELETE 금지 트리거를 걸기 때문이다 — 이 컬럼들을
-- "나중에 채워 넣는" 설계였다면 그 트리거와 정면으로 충돌한다.
alter table public.audit_logs
  add column phase text not null default 'SUCCEEDED'
    check (phase in ('ATTEMPTED', 'SUCCEEDED', 'FAILED')),
  add column correlation_id uuid not null default gen_random_uuid(),
  add column target_ref text;

comment on column public.audit_logs.phase is
  '한 커맨드의 실행 전(ATTEMPTED)/성공(SUCCEEDED)/실패(FAILED) 단계. 기존 행은 전부 SUCCEEDED로 채워졌다(기본값).';
comment on column public.audit_logs.correlation_id is
  '같은 커맨드의 ATTEMPTED 행과 결과 행을 묶는 값. ATTEMPTED만 있고 결과 행이 없으면 실행 도중 프로세스가 죽었다는 뜻이다.';
comment on column public.audit_logs.target_ref is
  'target_id(uuid)로 표현할 수 없는 대상(예: system_gates.code 같은 text 기본키). 2026-09-20 uuid 타입 오류의 구조적 해결책.';

-- =========================================================
-- 2. webhook_failures: 감사 기록 실패를 담을 source 값 추가
-- =========================================================
alter table public.webhook_failures drop constraint webhook_failures_source_check;
alter table public.webhook_failures
  add constraint webhook_failures_source_check
    check (source in ('TALLY', 'PAYAPP', 'MOCK', 'STEPPAY', 'OUTBOX', 'INTEGRITY', 'AUDIT'));
