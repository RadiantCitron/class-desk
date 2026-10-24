-- 결제 시작 시 "직전 PAYMENT_INITIATED가 10분 안이면 거부" 검사를 없앤다(2026-10-02).
-- 이유: 토스 결제창에서 결제 버튼을 누른 뒤 창을 닫으면 failUrl이 오지 않는 경우가 있어
-- (눈 확인 2026-10-02), 시도가 INITIATED로 남아 정상 사용자가 10분간 재결제를 못 했다.
-- 동시 클릭 직렬화(advisory lock + claim 행)는 그대로 둔다. 시도마다 orderId가 새로 발급되고
-- 이중 승인은 on_payment_succeeded가 DLQ로 거부하므로 대기 규칙 없이도 이중 결제는 막힌다.
--
-- p_window_minutes 인자는 더 이상 쓸 곳이 없어 함수를 새 시그니처(2인자)로 교체한다.

drop function public.claim_checkout_attempt(uuid, uuid, integer);

create function public.claim_checkout_attempt(
  p_order_id uuid,
  p_attempt_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed uuid;
  -- claim 행 TTL — PG createCheckout이 끝나기 전 동시 진입만 막으면 된다(기본 2분).
  v_claim_ttl interval := interval '2 minutes';
begin
  if p_order_id is null or p_attempt_id is null then
    raise exception 'order_id와 attempt_id는 필수입니다.';
  end if;

  perform pg_advisory_xact_lock(87201401, hashtext(p_order_id::text));

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

revoke execute on function public.claim_checkout_attempt(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_checkout_attempt(uuid, uuid)
  to service_role;
