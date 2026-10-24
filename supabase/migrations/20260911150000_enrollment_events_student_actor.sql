-- 학생이 직접 신청을 취소할 수 있게 되면서,
-- enrollment_events.actor가 더 이상 SYSTEM/ADMIN 둘로만 한정되지 않는다 — 학생 본인이 취소한
-- 이벤트는 actor='STUDENT'로 구분해서 남긴다(누가 취소했는지 이력에서 알 수 있어야 함).

alter table public.enrollment_events drop constraint enrollment_events_actor_check;
alter table public.enrollment_events
  add constraint enrollment_events_actor_check
    check (actor in ('SYSTEM', 'ADMIN', 'STUDENT'));

-- 아웃박스(권한부여) 처리 실패도 기존 DLQ(webhook_failures)에 남긴다 — audit_logs는
-- actor_user_id가 NOT NULL이라 사람이 하지 않은 시스템 실패엔 맞지 않고, webhook_failures는
-- 이미 "비동기 처리 실패, 관리자 확인 필요"라는 의미와 대시보드 배지를 갖추고 있다
-- (사용자 확인, 2026-09-11 — lib/outbox/drain.ts 참고).
alter table public.webhook_failures drop constraint webhook_failures_source_check;
alter table public.webhook_failures
  add constraint webhook_failures_source_check
    check (source in ('TALLY', 'PAYAPP', 'MOCK', 'STEPPAY', 'OUTBOX'));
