-- 이용권 부여·회수를 DB 함수로 이관하고,
-- discord_accounts 복제 테이블로 이용권→회원(users.discord_id) 읽기를 제거한다.

-- 1-1. discord_role_removed_at 정식 컬럼
alter table public.entitlements add column discord_role_removed_at timestamptz;

update public.entitlements
set discord_role_removed_at = (metadata->>'discord_role_removed_at')::timestamptz
where metadata ? 'discord_role_removed_at';

update public.entitlements
set metadata = metadata - 'discord_role_removed_at'
where metadata ? 'discord_role_removed_at';

-- 1-1b. outbox_messages_topic_check에 DISCORD_LINKED 추가
alter table public.outbox_messages drop constraint outbox_messages_topic_check;
alter table public.outbox_messages
  add constraint outbox_messages_topic_check
    check (
      topic in ('PAYMENT_SUCCEEDED', 'PAYMENT_REFUNDED', 'ORDER_PAID', 'ORDER_REFUNDED', 'USER_WITHDRAWN', 'DISCORD_LINKED')
      or (topic in ('GRANT_ENTITLEMENTS', 'REVOKE_ENTITLEMENTS', 'SEND_EMAIL') and processed_at is not null)
    );

-- 1-2. discord_accounts 테이블 (이용권 모듈 소유)
create table public.discord_accounts (
  user_id uuid primary key references public.users (id) on delete restrict,
  discord_id text not null,
  linked_at timestamptz not null default now()
);

alter table public.discord_accounts enable row level security;

insert into public.discord_accounts (user_id, discord_id)
select id, discord_id from public.users where discord_id is not null;

-- 1-3. link_discord_identity()가 DISCORD_LINKED 사실을 남긴다
create or replace function public.link_discord_identity(p_user_id uuid, p_discord_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
begin
  select discord_id into v_current from public.users where id = p_user_id for update;
  if not found then
    raise exception '회원을 찾을 수 없습니다.';
  end if;

  if v_current = p_discord_id then
    return; -- 같은 디스코드로 다시 연결 — 이미 기록돼 있다(멱등)
  end if;

  if v_current is not null then
    raise exception '이미 다른 디스코드 계정이 연결되어 있습니다. 관리자에게 문의해 주세요.';
  end if;

  update public.users set discord_id = p_discord_id where id = p_user_id;

  insert into public.account_events (user_id, event_type, actor, detail)
  values (p_user_id, 'IDENTITY_LINKED', 'SELF', jsonb_build_object('provider', 'discord'));

  -- 이용권 모듈이 이 사실을 받아 discord_accounts에 복제한다.
  insert into public.outbox_messages (topic, payload)
  values ('DISCORD_LINKED', jsonb_build_object('user_id', p_user_id, 'discord_id', p_discord_id));
end;
$$;

-- 1-4. record_discord_link() — 이용권 모듈의 DISCORD_LINKED 핸들러(DB 함수)
create function public.record_discord_link(p_user_id uuid, p_discord_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.discord_accounts (user_id, discord_id)
  values (p_user_id, p_discord_id)
  on conflict (user_id) do update set discord_id = excluded.discord_id;
end;
$$;

revoke execute on function public.record_discord_link(uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_discord_link(uuid, text)
  to service_role;

-- 1-5. generate_access_code()
create function public.generate_access_code()
returns text
language plpgsql
as $$
declare
  v_alphabet text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_code text := '';
  i integer;
begin
  for i in 1..16 loop
    v_code := v_code || substr(v_alphabet, 1 + floor(random() * 32)::int, 1);
  end loop;
  return v_code;
end;
$$;

revoke execute on function public.generate_access_code() from public, anon, authenticated;
grant execute on function public.generate_access_code() to service_role;

-- 1-6. grant_entitlements_for_order()
create function public.grant_entitlements_for_order(
  p_order_id uuid,
  p_user_id uuid,
  p_payment_event_id uuid,
  p_grants jsonb
)
returns setof public.entitlements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grants jsonb;
  v_elem jsonb;
begin
  if exists (select 1 from public.entitlements where payment_event_id = p_payment_event_id) then
    return query select * from public.entitlements where payment_event_id = p_payment_event_id;
    return;
  end if;

  v_grants := case when p_grants is null or jsonb_typeof(p_grants) <> 'array' or jsonb_array_length(p_grants) = 0
    then '[{"type": "COURSE_ACCESS"}]'::jsonb
    else p_grants
  end;

  for v_elem in select * from jsonb_array_elements(v_grants) loop
    insert into public.entitlements (
      user_id, type, order_id, payment_event_id, expires_at, max_uses, access_code, metadata
    ) values (
      p_user_id,
      v_elem->>'type',
      p_order_id,
      p_payment_event_id,
      case when nullif((v_elem->>'days')::integer, 0) is not null
        then now() + make_interval(days => (v_elem->>'days')::integer) else null end,
      (v_elem->>'max_uses')::integer,
      public.generate_access_code(),
      jsonb_strip_nulls(jsonb_build_object(
        'discord_role_id', v_elem->>'discord_role_id',
        'blob_pathname', v_elem->>'blob_pathname'
      ))
    )
    on conflict (
      payment_event_id,
      type,
      (coalesce(metadata->>'discord_role_id', '')),
      (coalesce(metadata->>'blob_pathname', ''))
    ) where payment_event_id is not null
    do nothing;
  end loop;

  return query select * from public.entitlements where payment_event_id = p_payment_event_id;
end;
$$;

revoke execute on function public.grant_entitlements_for_order(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.grant_entitlements_for_order(uuid, uuid, uuid, jsonb)
  to service_role;

-- 1-7. revoke_entitlements()
create function public.revoke_entitlements(
  p_user_id uuid,
  p_order_id uuid,
  p_reason text
)
returns table (entitlement_id uuid, role_id text, still_active boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_reason is null or p_reason not in ('REFUNDED', 'WITHDRAWN') then
    raise exception '알 수 없는 회수 사유입니다: %', p_reason;
  end if;

  update public.entitlements e
  set revoked_at = now(), revoked_reason = p_reason
  where e.user_id = p_user_id
    and e.revoked_at is null
    and (p_order_id is null or e.order_id = p_order_id);

  return query
  select
    e.id,
    e.metadata->>'discord_role_id',
    exists (
      select 1 from public.entitlements a
      where a.user_id = p_user_id
        and a.type = 'DISCORD_ROLE'
        and a.revoked_at is null
        and a.metadata->>'discord_role_id' = e.metadata->>'discord_role_id'
    )
  from public.entitlements e
  where e.user_id = p_user_id
    and e.type = 'DISCORD_ROLE'
    and e.revoked_reason = p_reason
    and e.revoked_at is not null
    and e.discord_role_removed_at is null
    and e.metadata ? 'discord_role_id'
    and (p_order_id is null or e.order_id = p_order_id);
end;
$$;

revoke execute on function public.revoke_entitlements(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.revoke_entitlements(uuid, uuid, text)
  to service_role;

-- 1-8. mark_discord_role_removed()
create function public.mark_discord_role_removed(p_entitlement_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.entitlements
  set discord_role_removed_at = now()
  where id = p_entitlement_id;
end;
$$;

revoke execute on function public.mark_discord_role_removed(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_discord_role_removed(uuid)
  to service_role;
