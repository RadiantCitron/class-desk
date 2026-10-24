--  — 아웃박스 러너 선점 + 이용권 이중 지급 방지.
--
-- 문제: 러너(lib/outbox/drain.ts)는 미처리 메시지를 그냥 select했다. 드레인 호출처가 셋(결제 웹훅·
-- 관리자 대시보드 렌더·크론)이라, 웹훅이 들어오는 순간 관리자가 대시보드를 열면 같은 메시지를 두
-- 러너가 동시에 처리했다 → 이용권 2벌 지급, 가짜 "이중결제 의심" DLQ.
--
-- ① claim_outbox_messages(): 처리할 메시지를 `for update skip locked`로 골라 next_attempt_at을
--    "지금 + 임대 시간"으로 밀어 둔 뒤 돌려준다. 다른 러너는 잠긴 행을 건너뛰고, 커밋 뒤에는
--    next_attempt_at이 미래라 다시 고르지 않는다. 새 컬럼 없이 기존 next_attempt_at을 임대로 쓴다 —
--    러너가 도중에 죽으면 임대가 끝난 뒤 다른 러너가 다시 처리한다(핸들러는 멱등).
-- ② entitlements 부분 유니크 인덱스: 한 결제 이벤트에서 "같은 종류·같은 대상" 이용권은 하나뿐.
--    역할이 다른 DISCORD_ROLE 여러 개는 허용된다. 러너 선점이 뚫려도(임대 만료 중 재처리) DB가 막는다.

create function public.claim_outbox_messages(p_limit integer, p_lease_seconds integer)
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

revoke execute on function public.claim_outbox_messages(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_outbox_messages(integer, integer)
  to service_role;

-- 기존 중복이 있으면 인덱스 생성이 실패한다 — 조용히 지우지 않고 중단한다(삭제 없음 원칙).
do $$
declare
  v_dup integer;
begin
  select count(*) into v_dup
  from (
    select 1
    from public.entitlements
    where payment_event_id is not null
    group by payment_event_id, type,
             coalesce(metadata->>'discord_role_id', ''),
             coalesce(metadata->>'blob_pathname', '')
    having count(*) > 1
  ) d;
  if v_dup > 0 then
    raise exception '같은 결제 이벤트로 중복 지급된 이용권 묶음이 %건 있습니다 — 마이그레이션을 중단합니다. 먼저 확인하세요.', v_dup;
  end if;
end $$;

create unique index entitlements_payment_grant_uniq
  on public.entitlements (
    payment_event_id,
    type,
    (coalesce(metadata->>'discord_role_id', '')),
    (coalesce(metadata->>'blob_pathname', ''))
  )
  where payment_event_id is not null;
