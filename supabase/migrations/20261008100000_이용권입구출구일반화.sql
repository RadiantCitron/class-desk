-- 권한의 입구·출구를 일반화한다. 입구 함수·출구 함수는 각각 하나로
-- 그대로 두고, 입구로 오는 "길"(부여 근거)과 출구로 가는 "길"(회수 사유)만 넓힌다.
--
--  · 부여 근거(grant_source): PAYMENT(결제 원장 행 payment_events.id) | ADMIN_GRANT(관리자 직권 부여
--    order_events.id). 근거 id는 종류에 따라 payment_event_id / grant_event_id 중 정확히 하나에 들어간다
--    (둘 다 FK 유지). 같은 근거로 두 번 부여해도 중복되지 않는다(멱등 유니크 인덱스 하나).
--  · 회수 사유: REFUNDED · WITHDRAWN(기존) + COURSE_ENDED(강의 종료) · ADMIN_CLOSED(직권 종료).
--
-- 지금 실제로 쓰는 길은 PAYMENT·REFUNDED·WITHDRAWN뿐이다. ADMIN_GRANT는 E-2, COURSE_ENDED는
-- E-3, ADMIN_CLOSED는 E-4가 사실(아웃박스)로 연결한다. 행은 지우지 않고 회수 표시만 한다.

-- 1. 부여 근거 칼럼 — 기존 행은 전부 PAYMENT(모두 payment_event_id가 있다).
alter table public.entitlements
  add column grant_source text not null default 'PAYMENT'
    constraint entitlements_grant_source_check check (grant_source in ('PAYMENT', 'ADMIN_GRANT')),
  add column grant_event_id uuid references public.order_events (id) on delete restrict;

alter table public.entitlements
  add constraint entitlements_grant_source_pair check (
    (grant_source = 'PAYMENT' and payment_event_id is not null and grant_event_id is null)
    or (grant_source = 'ADMIN_GRANT' and payment_event_id is null and grant_event_id is not null)
  );

-- 2. 멱등 유니크 인덱스 — payment_event_id 전용이던 것을 (근거 종류, 근거 id)로 넓힌다.
drop index public.entitlements_payment_grant_uniq;
create unique index entitlements_grant_uniq on public.entitlements (
  grant_source,
  (coalesce(payment_event_id, grant_event_id)),
  type,
  (coalesce(metadata->>'discord_role_id', '')),
  (coalesce(metadata->>'blob_pathname', ''))
);

-- 3. 입구 — 인자만 (근거 종류, 근거 id)로 바뀐다. 함수 이름·개수·반환은 그대로.
drop function public.grant_entitlements_for_order(uuid, uuid, uuid, jsonb);

create function public.grant_entitlements_for_order(
  p_order_id uuid,
  p_user_id uuid,
  p_source text,
  p_source_id uuid,
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
  v_payment_event_id uuid;
  v_grant_event_id uuid;
begin
  if p_source is null or p_source not in ('PAYMENT', 'ADMIN_GRANT') then
    raise exception '알 수 없는 부여 근거입니다: %', p_source;
  end if;
  if p_source_id is null then
    raise exception '부여 근거 id가 없습니다(%).', p_source;
  end if;

  if p_source = 'PAYMENT' then
    v_payment_event_id := p_source_id;
  else
    v_grant_event_id := p_source_id;
  end if;

  if exists (
    select 1 from public.entitlements
    where grant_source = p_source and coalesce(payment_event_id, grant_event_id) = p_source_id
  ) then
    return query
      select * from public.entitlements
      where grant_source = p_source and coalesce(payment_event_id, grant_event_id) = p_source_id;
    return;
  end if;

  v_grants := case when p_grants is null or jsonb_typeof(p_grants) <> 'array' or jsonb_array_length(p_grants) = 0
    then '[{"type": "COURSE_ACCESS"}]'::jsonb
    else p_grants
  end;

  for v_elem in select * from jsonb_array_elements(v_grants) loop
    insert into public.entitlements (
      user_id, type, order_id, grant_source, payment_event_id, grant_event_id,
      expires_at, max_uses, access_code, metadata
    ) values (
      p_user_id,
      v_elem->>'type',
      p_order_id,
      p_source,
      v_payment_event_id,
      v_grant_event_id,
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
      grant_source,
      (coalesce(payment_event_id, grant_event_id)),
      type,
      (coalesce(metadata->>'discord_role_id', '')),
      (coalesce(metadata->>'blob_pathname', ''))
    )
    do nothing;
  end loop;

  return query
    select * from public.entitlements
    where grant_source = p_source and coalesce(payment_event_id, grant_event_id) = p_source_id;
end;
$$;

revoke execute on function public.grant_entitlements_for_order(uuid, uuid, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.grant_entitlements_for_order(uuid, uuid, text, uuid, jsonb)
  to service_role;

-- 4. 출구 — 회수 사유만 넓힌다(본문은 20260925150200과 같다). 시그니처가 같아 권한은 그대로 유지된다.
create or replace function public.revoke_entitlements(
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
  if p_reason is null or p_reason not in ('REFUNDED', 'WITHDRAWN', 'COURSE_ENDED', 'ADMIN_CLOSED') then
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
