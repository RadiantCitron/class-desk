-- A-3: 선별·일괄 환불 지원 (p_batch_id uuid, p_operator_cause boolean) 및 OPERATOR_REFUND 원인
-- 의존: 20261011150000_폐강환불구멍.sql (9인자 begin_refund_request), 20261011100000_설계된예외경로.sql (on_payment_refunded)

-- =====================================================================
-- 1. begin_refund_request: 11인자 버전으로 확장
-- =====================================================================
drop function if exists public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean, uuid);
drop function if exists public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean, uuid, uuid, boolean);

create function public.begin_refund_request(
  p_order_id uuid,
  p_request_key text,
  p_amount integer,
  p_reason text,
  p_source text,
  p_student_request_event_id uuid default null::uuid,
  p_schedule_change_notice_event_id uuid default null::uuid,
  p_post_close boolean default false,
  p_actor_id uuid default null::uuid,
  p_batch_id uuid default null::uuid,
  p_operator_cause boolean default false
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
set search_path to 'public'
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
  if p_source in ('ADMIN', 'OFFERING_CANCEL') and p_actor_id is null then
    raise exception '관리자 환불 요청에는 행위자 ID(p_actor_id)가 필수입니다.';
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
    jsonb_build_object('reason', p_reason, 'source', p_source, 'request_key', p_request_key)
      || case when p_actor_id is not null
           then jsonb_build_object('actor_user_id', p_actor_id)
           else '{}'::jsonb end
      || case when p_student_request_event_id is not null
           then jsonb_build_object('student_request_event_id', p_student_request_event_id)
           else '{}'::jsonb end
      || case when p_schedule_change_notice_event_id is not null
           then jsonb_build_object('schedule_change_notice_event_id', p_schedule_change_notice_event_id)
           else '{}'::jsonb end
      || case when p_post_close is true
           then jsonb_build_object('post_close', true)
           else '{}'::jsonb end
      || case when p_batch_id is not null
           then jsonb_build_object('batch_id', p_batch_id)
           else '{}'::jsonb end
      || case when p_operator_cause is true
           then jsonb_build_object('operator_cause', true)
           else '{}'::jsonb end,
    jsonb_build_object('requested_amount', v_amount, 'refundable_before', v_refundable)
  )
  returning id into request_event_id;

  outcome := 'CREATED';
  provider := v_paid.provider;
  provider_transaction_id := v_paid.provider_transaction_id;
  refundable := v_refundable;
  payment_amount := v_paid.amount;
  return next;
end;
$$;

revoke execute on function public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean, uuid, uuid, boolean) to service_role;

-- =====================================================================
-- 2. record_payment_event: operator_cause 분기 지원
-- =====================================================================
-- 2. record_payment_event: operator_cause 분기 지원 (20261011150000 정본 기반)
-- =====================================================================
create or replace function public.record_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_amount integer,
  p_currency text,
  p_order_id uuid,
  p_payment_method text,
  p_metadata jsonb,
  p_raw_payload jsonb,
  p_provider_transaction_id text default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_event_id uuid;
  v_cause text;
  v_reason text;
  v_req record;
  v_paid_amount integer;
  v_refunded_sum integer;
  v_refundable integer;
begin
  if p_order_id is null then
    raise exception '존재하지 않는 주문: %', p_order_id;
  end if;

  -- PG 외(MANUAL) 환불 상한 검사: 결제 모듈 자기 원장(payment_events) 기준
  if p_provider = 'MANUAL' and p_event_type = 'REFUNDED' then
    select pe.amount into v_paid_amount
    from public.payment_events pe
    where pe.order_id = p_order_id
      and pe.event_type = 'PAYMENT_SUCCEEDED'
    order by pe.created_at desc
    limit 1;

    select coalesce(sum(pe.amount), 0) into v_refunded_sum
    from public.payment_events pe
    where pe.order_id = p_order_id
      and pe.event_type = 'REFUNDED';

    v_refundable := coalesce(v_paid_amount, 0) - v_refunded_sum;
    if v_refundable < 0 then
      v_refundable := 0;
    end if;

    if p_amount <= 0 or p_amount > v_refundable then
      raise exception '환불 금액(%원)이 남은 환불 가능액(%원)을 초과합니다.', p_amount, v_refundable;
    end if;
  end if;

  insert into public.payment_events (
    provider, provider_event_id, provider_transaction_id, event_type, amount, currency,
    order_id, payment_method, metadata, raw_payload
  ) values (
    p_provider, p_provider_event_id, p_provider_transaction_id, p_event_type, p_amount, p_currency,
    p_order_id, p_payment_method, p_metadata, p_raw_payload
  )
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return false;
  end if;

  if p_event_type = 'PAYMENT_SUCCEEDED' then
    insert into public.outbox_messages (topic, payload)
    values ('PAYMENT_SUCCEEDED', jsonb_build_object(
      'payment_event_id', v_event_id,
      'order_id', p_order_id,
      'provider', p_provider,
      'amount', p_amount,
      'currency', p_currency,
      'payment_method', p_payment_method,
      'metadata', p_metadata
    ));
  elsif p_event_type = 'REFUNDED' then
    if p_metadata->>'source' = 'ADMIN_MANUAL_REFUND' then
      if (p_metadata->>'post_close')::boolean is true then
        v_cause := 'POST_CLOSE_REFUND';
      elsif (p_metadata->>'operator_cause')::boolean is true then
        v_cause := 'OPERATOR_REFUND';
      else
        v_cause := 'ADMIN_REFUND';
      end if;
      v_reason := p_metadata->>'reason';
    else
      select pe.metadata->>'source' as source, pe.metadata->>'reason' as reason,
             pe.metadata->>'student_request_event_id' as student_request_event_id,
             pe.metadata->>'schedule_change_notice_event_id' as schedule_change_notice_event_id,
             (pe.metadata->>'post_close')::boolean as post_close,
             (pe.metadata->>'operator_cause')::boolean as operator_cause
        into v_req
      from public.payment_events pe
      where pe.order_id = p_order_id
        and pe.event_type = 'REFUND_REQUESTED'
        and not exists (
          select 1 from public.payment_events pe2
          where pe2.order_id = p_order_id
            and pe2.event_type in ('REFUNDED', 'REFUND_REQUEST_FAILED')
            and pe2.id <> v_event_id
            and pe2.created_at > pe.created_at
        )
      order by pe.created_at desc
      limit 1;

      if v_req.post_close is true then
        v_cause := 'POST_CLOSE_REFUND';
        v_reason := v_req.reason;
      elsif v_req.source = 'ADMIN' then
        -- 우선순위: 일정 변경 안내 id > 우리 사정(operator_cause) > 학생 신청 id > ADMIN_REFUND
        v_cause := case
          when v_req.schedule_change_notice_event_id is not null then 'SCHEDULE_CHANGE'
          when v_req.operator_cause is true then 'OPERATOR_REFUND'
          when v_req.student_request_event_id is not null then 'STUDENT_REFUND'
          else 'ADMIN_REFUND'
        end;
        v_reason := v_req.reason;
      elsif v_req.source = 'OFFERING_CANCEL' then
        v_cause := 'OFFERING_CANCELLED';
        v_reason := v_req.reason;
      else
        v_cause := 'EXTERNAL_REFUND';
      end if;
    end if;

    insert into public.outbox_messages (topic, payload)
    values ('PAYMENT_REFUNDED', jsonb_build_object(
      'payment_event_id', v_event_id,
      'order_id', p_order_id,
      'provider', p_provider,
      'amount', p_amount,
      'currency', p_currency,
      'cause', v_cause,
      'reason', v_reason
    ));
  end if;

  return true;
end;
$$;

revoke execute on function public.record_payment_event(text, text, text, integer, text, uuid, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_payment_event(text, text, text, integer, text, uuid, text, jsonb, jsonb, text) to service_role;
