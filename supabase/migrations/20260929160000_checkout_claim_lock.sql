-- F-15(2026-09-29): 결제 시작 동시 클릭 직렬화.
-- NO_PENDING_CHECKOUT은 check-then-act라, 가드를 통과한 두 요청이 둘 다 createCheckout을
-- 부르면 라이브 세션이 둘 생긴다(INITIATED 키가 매 시도 randomUUID). 이중 결제 자체는
-- on_payment_succeeded가 DLQ로 막지만, PG 세션 중복은 막아야 한다.
--
-- payment_events에 INITIATED를 선기록하면 PG 실패 시 10분 봉쇄가 재발한다(장애유형교차카탈로그
-- 4-1). 그래서 원장과 분리된 짧은 수명 claim 행 + 트랜잭션 안 advisory lock으로 슬롯만 잡는다.
-- claim TTL(기본 2분)은 createCheckout HTTP 왕복용이고, INITIATED 유예(10분)와는 별개다.

create table public.payment_checkout_claims (
  order_id   uuid primary key references public.orders (id),
  attempt_id uuid not null,
  claimed_at timestamptz not null default now()
);

comment on table public.payment_checkout_claims is
  '결제 시작(createCheckout) 직전~성공/실패 직후 구간을 직렬화하는 짧은 수명 잠금. append-only 원장에 선기록하지 않기 위함.';

alter table public.payment_checkout_claims enable row level security;
-- 정책 없음 — service_role(admin 클라이언트)만. payment_settings와 동일.

-- class-desk 전용 advisory lock 네임스페이스(다른 용도와 숫자를 겹치지 않게 고정).
-- hashtext(order_id)와 짝을 이뤄 주문 단위로 직렬화한다.
create or replace function public.claim_checkout_attempt(
  p_order_id uuid,
  p_attempt_id uuid,
  p_window_minutes integer default 10
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest_type text;
  v_latest_at timestamptz;
  v_claimed uuid;
  -- claim 행 TTL — PG createCheckout이 끝나기 전 동시 진입만 막으면 된다(기본 2분).
  v_claim_ttl interval := interval '2 minutes';
begin
  if p_order_id is null or p_attempt_id is null then
    raise exception 'order_id와 attempt_id는 필수입니다.';
  end if;
  if p_window_minutes is null or p_window_minutes < 1 then
    raise exception 'window_minutes는 1 이상이어야 합니다.';
  end if;

  perform pg_advisory_xact_lock(87201401, hashtext(p_order_id::text));

  select event_type, created_at
    into v_latest_type, v_latest_at
  from public.payment_events
  where order_id = p_order_id
  order by created_at desc
  limit 1;

  if v_latest_type = 'PAYMENT_INITIATED'
     and v_latest_at > now() - make_interval(mins => p_window_minutes) then
    raise exception 'CHECKOUT_ALREADY_PENDING'
      using errcode = 'P0001';
  end if;

  insert into public.payment_checkout_claims as c (order_id, attempt_id, claimed_at)
  values (p_order_id, p_attempt_id, now())
  on conflict (order_id) do update
    set attempt_id = excluded.attempt_id,
        claimed_at = excluded.claimed_at
    where c.claimed_at < now() - v_claim_ttl
       or c.attempt_id = excluded.attempt_id
  returning c.order_id into v_claimed;

  if v_claimed is null then
    raise exception 'CHECKOUT_ALREADY_PENDING'
      using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.release_checkout_claim(
  p_order_id uuid,
  p_attempt_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 삭제 없음: claimed_at을 epoch로 밀어 TTL 만료와 같게 만든다(재claim 가능).
  update public.payment_checkout_claims
  set claimed_at = 'epoch'::timestamptz
  where order_id = p_order_id
    and attempt_id = p_attempt_id;
end;
$$;

revoke execute on function public.claim_checkout_attempt(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_checkout_attempt(uuid, uuid, integer)
  to service_role;

revoke execute on function public.release_checkout_claim(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.release_checkout_claim(uuid, uuid)
  to service_role;
