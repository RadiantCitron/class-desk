-- F-15 보정: release_checkout_claim은 DELETE가 아니라 claimed_at을 epoch로 밀어 TTL을
-- 즉시 만료시킨다("삭제 없음" — boundaries.guard SQL-DELETE 금지).

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
  update public.payment_checkout_claims
  set claimed_at = 'epoch'::timestamptz
  where order_id = p_order_id
    and attempt_id = p_attempt_id;
end;
$$;
