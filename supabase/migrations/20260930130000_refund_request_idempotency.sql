-- 환불 개시 멱등(D15)·REFUND_REQUESTED/FAILED 원장 타입.
-- begin_refund_request는 payment_events만 읽고 orders를 읽지 않는다.

-- =====================================================================
-- 1. event_type CHECK 확장
-- =====================================================================
alter table public.payment_events
  drop constraint if exists payment_events_event_type_check;

alter table public.payment_events
  add constraint payment_events_event_type_check
  check (event_type in (
    'PAYMENT_INITIATED',
    'PAYMENT_SUCCEEDED',
    'PAYMENT_FAILED',
    'REFUNDED',
    'REFUND_REQUESTED',
    'REFUND_REQUEST_FAILED'
  ));

-- =====================================================================
-- 2. begin_refund_request — PG 호출 전 원장 사전 기록 + 주문별 잠금
-- =====================================================================
create function public.begin_refund_request(
  p_order_id uuid,
  p_request_key text,
  p_amount integer,
  p_reason text,
  p_source text
)
returns table(
  outcome text,
  request_event_id uuid,
  provider text,
  provider_transaction_id text,
  refundable integer,
  payment_amount integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_existing record;
  v_paid record;
  v_refunded_sum integer;
  v_refundable integer;
  v_amount integer;
  v_open record;
  v_after_close boolean;
  v_new_id uuid;
begin
  if p_order_id is null then
    raise exception '주문 ID가 필요합니다.';
  end if;
  if p_request_key is null or btrim(p_request_key) = '' then
    raise exception '환불 요청 키가 필요합니다.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '환불 사유를 입력해야 합니다.';
  end if;
  if p_source is null or p_source not in ('ADMIN', 'OFFERING_CANCEL') then
    raise exception '환불 출처는 ADMIN 또는 OFFERING_CANCEL만 허용됩니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('refund:' || p_order_id::text, 0));

  v_key := 'refund-req:' || p_request_key;

  -- 같은 요청 키 재진입
  select pe.id, pe.created_at, pe.provider, pe.provider_transaction_id, pe.amount
    into v_existing
  from public.payment_events pe
  where pe.provider_event_id = v_key
  order by pe.created_at desc
  limit 1;

  if v_existing.id is not null then
    select exists (
      select 1 from public.payment_events pe2
      where pe2.order_id = p_order_id
        and pe2.event_type in ('REFUNDED', 'REFUND_REQUEST_FAILED')
        and pe2.created_at > v_existing.created_at
    ) into v_after_close;

    if v_after_close then
      outcome := 'KEY_USED';
      request_event_id := v_existing.id;
      provider := v_existing.provider;
      provider_transaction_id := v_existing.provider_transaction_id;
      refundable := null;
      payment_amount := null;
      return next;
      return;
    else
      outcome := 'OPEN_EXISTS';
      request_event_id := v_existing.id;
      provider := v_existing.provider;
      provider_transaction_id := v_existing.provider_transaction_id;
      refundable := null;
      payment_amount := null;
      return next;
      return;
    end if;
  end if;

  -- 최신 PAYMENT_SUCCEEDED
  select pe.id, pe.provider, pe.provider_transaction_id, pe.amount
    into v_paid
  from public.payment_events pe
  where pe.order_id = p_order_id
    and pe.event_type = 'PAYMENT_SUCCEEDED'
  order by pe.created_at desc
  limit 1;

  if v_paid.id is null then
    outcome := 'NOT_PAID';
    request_event_id := null;
    provider := null;
    provider_transaction_id := null;
    refundable := 0;
    payment_amount := null;
    return next;
    return;
  end if;

  select coalesce(sum(pe.amount), 0) into v_refunded_sum
  from public.payment_events pe
  where pe.order_id = p_order_id
    and pe.event_type = 'REFUNDED';

  v_refundable := v_paid.amount - v_refunded_sum;
  if v_refundable < 0 then
    v_refundable := 0;
  end if;

  -- 열린 요청(가장 최근 REFUND_REQUESTED 이후 닫힘 없음)
  select pe.id, pe.created_at, pe.provider, pe.provider_transaction_id
    into v_open
  from public.payment_events pe
  where pe.order_id = p_order_id
    and pe.event_type = 'REFUND_REQUESTED'
  order by pe.created_at desc
  limit 1;

  if v_open.id is not null then
    select exists (
      select 1 from public.payment_events pe2
      where pe2.order_id = p_order_id
        and pe2.event_type in ('REFUNDED', 'REFUND_REQUEST_FAILED')
        and pe2.created_at > v_open.created_at
    ) into v_after_close;

    if not v_after_close then
      outcome := 'OPEN_EXISTS';
      request_event_id := v_open.id;
      provider := v_open.provider;
      provider_transaction_id := v_open.provider_transaction_id;
      refundable := v_refundable;
      payment_amount := v_paid.amount;
      return next;
      return;
    end if;
  end if;

  if v_refundable = 0 then
    outcome := 'NOTHING_TO_REFUND';
    request_event_id := null;
    provider := v_paid.provider;
    provider_transaction_id := v_paid.provider_transaction_id;
    refundable := 0;
    payment_amount := v_paid.amount;
    return next;
    return;
  end if;

  if p_amount is null then
    v_amount := v_refundable;
  else
    if p_amount <= 0 or p_amount > v_refundable then
      raise exception '환불 금액이 올바르지 않습니다(가능액 %원).', v_refundable;
    end if;
    v_amount := p_amount;
  end if;

  insert into public.payment_events (
    provider, provider_event_id, provider_transaction_id, event_type,
    amount, currency, order_id, payment_method, metadata, raw_payload
  ) values (
    v_paid.provider,
    v_key,
    v_paid.provider_transaction_id,
    'REFUND_REQUESTED',
    v_amount,
    'KRW',
    p_order_id,
    null,
    jsonb_build_object('reason', p_reason, 'source', p_source, 'request_key', p_request_key),
    '{}'::jsonb
  )
  returning id into v_new_id;

  outcome := 'CREATED';
  request_event_id := v_new_id;
  provider := v_paid.provider;
  provider_transaction_id := v_paid.provider_transaction_id;
  refundable := v_refundable;
  payment_amount := v_paid.amount;
  return next;
end;
$$;

revoke execute on function public.begin_refund_request(uuid, text, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.begin_refund_request(uuid, text, integer, text, text)
  to service_role;

-- =====================================================================
-- 3. fail_refund_request — 명시적 거절만 기록(멱등)
-- =====================================================================
create function public.fail_refund_request(
  p_request_event_id uuid,
  p_error text,
  p_source text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req record;
  v_closed boolean;
  v_request_key text;
begin
  if p_request_event_id is null then
    raise exception '요청 이벤트 ID가 필요합니다.';
  end if;

  select pe.* into v_req
  from public.payment_events pe
  where pe.id = p_request_event_id
  for update;

  if v_req.id is null then
    raise exception '환불 요청을 찾을 수 없습니다.';
  end if;
  if v_req.event_type <> 'REFUND_REQUESTED' then
    raise exception 'REFUND_REQUESTED 행만 실패로 표시할 수 있습니다.';
  end if;

  select exists (
    select 1 from public.payment_events pe2
    where pe2.order_id = v_req.order_id
      and pe2.event_type in ('REFUNDED', 'REFUND_REQUEST_FAILED')
      and pe2.created_at > v_req.created_at
  ) into v_closed;

  if v_closed then
    return; -- 이미 닫힘 — 멱등 no-op
  end if;

  v_request_key := coalesce(v_req.metadata->>'request_key', replace(v_req.provider_event_id, 'refund-req:', ''));

  insert into public.payment_events (
    provider, provider_event_id, provider_transaction_id, event_type,
    amount, currency, order_id, payment_method, metadata, raw_payload
  ) values (
    v_req.provider,
    'refund-fail:' || v_request_key,
    v_req.provider_transaction_id,
    'REFUND_REQUEST_FAILED',
    v_req.amount,
    'KRW',
    v_req.order_id,
    null,
    jsonb_build_object(
      'error', coalesce(p_error, ''),
      'source', coalesce(p_source, ''),
      'request_event_id', p_request_event_id
    ),
    '{}'::jsonb
  )
  on conflict (provider, provider_event_id) do nothing;
end;
$$;

revoke execute on function public.fail_refund_request(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_refund_request(uuid, text, text)
  to service_role;
