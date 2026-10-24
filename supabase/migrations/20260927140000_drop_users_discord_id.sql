-- 디스코드 채팅방 입장 기능 7단계(2026-09-27, 마지막) — users.discord_id를 없앤다. 이 시점엔
-- 코드가 전부 discord_accounts로 옮겨갔다(2026-09-27110000~130000 + 화면/테스트 코드 수정).
-- link_discord_identity()의 과도기 UPDATE(20260927110000)도 이 마이그레이션과 함께 없앤다.

do $$
begin
  if exists (
    select 1 from public.users u where u.discord_id is not null
      and not exists (select 1 from public.discord_accounts d where d.user_id = u.id)
  ) then
    raise exception 'discord_accounts에 없는 users.discord_id가 있습니다 — 마이그레이션 중단.';
  end if;
end $$;

create or replace function public.link_discord_identity(p_user_id uuid, p_discord_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
begin
  select discord_id into v_current from public.discord_accounts where user_id = p_user_id for update;
  if v_current = p_discord_id then
    return; -- 같은 디스코드로 다시 연결 — 이미 기록돼 있다(멱등)
  end if;

  if v_current is not null then
    raise exception '이미 다른 디스코드 계정이 연결되어 있습니다. 관리자에게 문의해 주세요.';
  end if;

  -- discord_accounts.user_id의 FK(references users)가 "회원이 존재하는가"를 대신 검증한다.
  insert into public.discord_accounts (user_id, discord_id)
  values (p_user_id, p_discord_id)
  on conflict (user_id) do update set discord_id = excluded.discord_id;

  insert into public.account_events (user_id, event_type, actor, detail)
  values (p_user_id, 'IDENTITY_LINKED', 'SELF', jsonb_build_object('provider', 'discord'));
end;
$$;

alter table public.users drop constraint users_discord_id_key;
alter table public.users drop column discord_id;
