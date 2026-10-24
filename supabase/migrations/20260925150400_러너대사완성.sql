alter table public.outbox_messages add column dead_at timestamptz;

-- 시그니처 불변 — create or replace로 덮어쓴다. dead_at이 찍힌 메시지는 더 이상 집지 않는다.
create or replace function public.claim_outbox_messages(p_limit integer, p_lease_seconds integer)
returns setof public.outbox_messages
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_limit is null or p_limit < 1 or p_lease_seconds is null or p_lease_seconds < 1 then
    raise exception 'claim_outbox_messages: p_limit, p_lease_seconds는 1 이상이어야 합니다';
  end if;

  return query
  with picked as (
    select id
    from public.outbox_messages
    where processed_at is null
      and dead_at is null
      and next_attempt_at <= now()
    order by created_at
    limit p_limit
    for update skip locked
  )
  update public.outbox_messages m
  set next_attempt_at = now() + make_interval(secs => p_lease_seconds)
  from picked
  where m.id = picked.id
  returning m.*;
end;
$$;

-- 관리자가 "재시도"를 누르면 dead_at을 지우고 즉시 다시 집히게 한다(next_attempt_at=now()).
-- attempts는 0으로 되돌리지 않는다 — "몇 번 실패했었는지" 이력은 last_error와 함께 남겨 두는 게
-- 진단에 낫다(삭제 없음 원칙과 같은 결). 다음 실패부터 다시 attempts가 올라간다.
create function public.reset_dead_outbox_message(p_outbox_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.outbox_messages
  set dead_at = null,
      next_attempt_at = now()
  where id = p_outbox_message_id and dead_at is not null;

  if not found then
    raise exception '이미 처리됐거나 죽은 상태가 아닌 메시지입니다.';
  end if;
end;
$$;

revoke execute on function public.reset_dead_outbox_message(uuid)
  from public, anon, authenticated;
grant execute on function public.reset_dead_outbox_message(uuid)
  to service_role;
