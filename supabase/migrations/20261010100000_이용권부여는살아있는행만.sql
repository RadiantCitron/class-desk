-- F-1: 이용권 부여 함수는 살아 있는(revoked_at is null) 행만 반환한다.
-- 환불·종료·제외로 회수된 이용권에 대해 늦게 도는 아웃박스 부여 재시도가 디스코드 역할을 되살리는 버그를 차단한다.
-- 멱등 판정: 이미 근거 행이 존재하면 새로 만들지 않으며, 살아 있는 행만 돌려준다(전부 회수됐으면 0행 반환).
-- R1 준수: 이용권 모듈(entitlements) 자기 테이블만 읽고 쓴다.

create or replace function public.grant_entitlements_for_order(
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
      where grant_source = p_source and coalesce(payment_event_id, grant_event_id) = p_source_id
        and revoked_at is null;
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
    where grant_source = p_source and coalesce(payment_event_id, grant_event_id) = p_source_id
      and revoked_at is null;
end;
$$;

revoke execute on function public.grant_entitlements_for_order(uuid, uuid, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.grant_entitlements_for_order(uuid, uuid, text, uuid, jsonb)
  to service_role;
