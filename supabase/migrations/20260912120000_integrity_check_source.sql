-- 무결성 점검 계층(lib/integrity/checks.ts)이 발견한 문제를 기존 DLQ(webhook_failures)에
-- 남기기 위해 source 값을 하나 추가한다. 새 화면을 만들지 않고 이미 있는 /admin/dlq에서
-- 바로 보이게 하기 위함.

alter table public.webhook_failures drop constraint webhook_failures_source_check;
alter table public.webhook_failures
  add constraint webhook_failures_source_check
    check (source in ('TALLY', 'PAYAPP', 'MOCK', 'STEPPAY', 'OUTBOX', 'INTEGRITY'));
