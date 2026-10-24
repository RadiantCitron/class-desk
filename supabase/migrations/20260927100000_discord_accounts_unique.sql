-- 디스코드 채팅방 입장 기능 1단계(2026-09-27) — users.discord_id를 없애기 전 안전망.
-- 지금은 users.discord_id의 UNIQUE 제약이 "같은 디스코드 계정이 두 회원에 연결되는 것"을
-- 막는 유일한 방벽이다. users.discord_id를 지우기(이후 마이그레이션) 전에, 같은 역할을
-- discord_accounts.discord_id로 먼저 옮겨 둔다.
--
-- 적용 전 재확인(로컬에서 이 마이그레이션을 만들며 직접 실행): 로컬 DB엔 discord_accounts
-- 행이 0건이라 지금은 중복이 없다. 운영에 적용할 때도 아래로 한 번 더 확인할 것:
--   select discord_id, count(*) from discord_accounts group by 1 having count(*) > 1;

do $$
declare
  v_dup integer;
begin
  select count(*) into v_dup from (
    select discord_id from public.discord_accounts group by discord_id having count(*) > 1
  ) d;
  if v_dup > 0 then
    raise exception 'discord_accounts.discord_id 중복이 %건 있습니다 — 마이그레이션을 중단합니다.', v_dup;
  end if;
end $$;

alter table public.discord_accounts
  add constraint discord_accounts_discord_id_key unique (discord_id);
