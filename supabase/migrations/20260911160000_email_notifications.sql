-- 이메일 발송도 결제 후처리(entitlements)와 같은 아웃박스 메커니즘을 탄다 — 원장 기록과
-- 같은 트랜잭션에서 "보내야 할 메일이 있다"는 사실을 적재하고, 실제 발송(외부 I/O)은
-- 트랜잭션 밖(lib/outbox/drain.ts)에서 처리한다. 실패해도 기존 DLQ(webhook_failures)로
-- 남는다. (이메일도 로컬에서는 흉내만 낸다)

alter table public.outbox_messages drop constraint outbox_messages_topic_check;
alter table public.outbox_messages
  add constraint outbox_messages_topic_check
    check (topic in ('GRANT_ENTITLEMENTS', 'SEND_EMAIL'));
