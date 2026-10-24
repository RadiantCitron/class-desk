-- 디스코드 채팅방 입장 기능 3단계(2026-09-27) — 디스코드 길드 자동추가(Add Guild Member)
-- 실패를 기록할 dead_letters source 값을 추가한다. access_token/refresh_token은 여기 payload에
-- 절대 넣지 않는다(user_id/discord_id/에러메시지만) — 토큰은 콜백 요청 안에서만 쓰고
-- DB에 저장하지 않기로 확정했다(2026-09-27 대화).

alter table public.dead_letters drop constraint dead_letters_source_check;
alter table public.dead_letters add constraint dead_letters_source_check
  check (source = any (array['PAYAPP', 'MOCK', 'STEPPAY', 'OUTBOX', 'INTEGRITY', 'AUDIT', 'INTERNAL', 'DISCORD_GUILD_JOIN']));
