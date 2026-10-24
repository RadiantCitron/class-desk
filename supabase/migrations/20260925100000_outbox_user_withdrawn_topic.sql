-- (위반 V4) — 탈퇴가 이용권 모듈에게 "회수해라"(REVOKE_ENTITLEMENTS,
-- 명령형)를 보내던 것을, 회원 모듈의 과거형 사실 "탈퇴했다"(USER_WITHDRAWN)로 바꾼다. 무엇을
-- 회수할지는 받는 쪽(이용권 모듈)이 정한다 — 보내는 쪽이 받는 쪽의 할 일을 알면 안 된다(R2).
-- 옛 토픽 3개는 record_payment_event()가 아직 적재하므로 C단계까지 그대로 둔다.
alter table public.outbox_messages drop constraint outbox_messages_topic_check;
alter table public.outbox_messages
  add constraint outbox_messages_topic_check
    check (topic in ('GRANT_ENTITLEMENTS', 'SEND_EMAIL', 'REVOKE_ENTITLEMENTS', 'USER_WITHDRAWN'));
