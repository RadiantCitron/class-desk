-- 수강 유지 부분 환불 (회차 취소 보상 환불)
-- 의존: 20261012140000_자동환불옵션.sql (begin_refund_request, record_payment_event), 20261011130000_계약조건변경과탈퇴감시.sql (on_payment_refunded)

-- 1. begin_refund_request 재작성: p_keep_order boolean default false 추가 (12인자)
-- 기존 11인자 함수 삭제 후 12인자 함수 생성
drop function if exists public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean, uuid, uuid, boolean);
drop function if exists public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean, uuid, uuid, boolean, boolean);

create or replace function public.begin_refund_request(
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
  p_operator_cause boolean default false,
  p_keep_order boolean default false
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
  if p_source is null or p_source not in ('ADMIN', 'OFFERING_CANCEL', 'AUTO') then
    raise exception '환불 출처는 ADMIN, OFFERING_CANCEL 또는 AUTO만 허용됩니다.';
  end if;
  if p_source in ('ADMIN', 'OFFERING_CANCEL', 'AUTO') and p_actor_id is null then
    raise exception '환불 요청에는 행위자 ID(p_actor_id)가 필수입니다.';
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
           else '{}'::jsonb end
      || case when p_keep_order is true
           then jsonb_build_object('keep_order', true)
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

revoke execute on function public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean, uuid, uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean, uuid, uuid, boolean, boolean) to service_role;


-- 2. record_payment_event: keep_order 플래그 outbox_messages 에 전달
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
  v_keep_order boolean := false;
  v_req record;
  v_paid_amount integer;
  v_refunded_sum integer;
  v_refundable integer;
begin
  if p_order_id is null then
    raise exception '존재하지 않는 주문: %', p_order_id;
  end if;

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
      v_keep_order := coalesce((p_metadata->>'keep_order')::boolean, false);
      if (p_metadata->>'post_close')::boolean is true then
        v_cause := 'POST_CLOSE_REFUND';
      elsif (p_metadata->>'operator_cause')::boolean is true then
        v_cause := 'OPERATOR_REFUND';
      elsif v_keep_order is true then
        v_cause := 'SESSION_COMPENSATION';
      else
        v_cause := 'ADMIN_REFUND';
      end if;
      v_reason := p_metadata->>'reason';
    else
      select pe.metadata->>'source' as source, pe.metadata->>'reason' as reason,
             pe.metadata->>'student_request_event_id' as student_request_event_id,
             pe.metadata->>'schedule_change_notice_event_id' as schedule_change_notice_event_id,
             (pe.metadata->>'post_close')::boolean as post_close,
             (pe.metadata->>'operator_cause')::boolean as operator_cause,
             (pe.metadata->>'keep_order')::boolean as keep_order
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

      v_keep_order := coalesce(v_req.keep_order, false);

      if v_req.post_close is true then
        v_cause := 'POST_CLOSE_REFUND';
        v_reason := v_req.reason;
      elsif v_req.source in ('ADMIN', 'AUTO') then
        v_cause := case
          when v_req.schedule_change_notice_event_id is not null then 'SCHEDULE_CHANGE'
          when v_req.operator_cause is true then 'OPERATOR_REFUND'
          when v_keep_order is true then 'SESSION_COMPENSATION'
          when v_req.student_request_event_id is not null or v_req.source = 'AUTO' then 'STUDENT_REFUND'
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
      'reason', v_reason,
      'keep_order', v_keep_order
    ));
  end if;

  return true;
end;
$$;

revoke execute on function public.record_payment_event(
  text, text, text, integer, text, uuid, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.record_payment_event(
  text, text, text, integer, text, uuid, text, jsonb, jsonb, text
) to service_role;


-- 3. on_payment_refunded 재작성: p_keep_order 지원
-- 기존 함수 시그니처 대체 (p_keep_order boolean default false 추가)
drop function if exists public.on_payment_refunded(uuid, uuid, text, integer, text, text, text);
drop function if exists public.on_payment_refunded(uuid, uuid, text, integer, text, text, text, boolean);

create or replace function public.on_payment_refunded(
  p_payment_event_id uuid,
  p_order_id uuid,
  p_provider text,
  p_amount integer,
  p_currency text,
  p_cause text default null::text,
  p_reason text default null::text,
  p_keep_order boolean default false
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order record;
  v_new_total integer;
  v_partial boolean;
  v_first_class_date date;
  v_total_sessions integer;
  v_past_sessions integer;
  v_effective_cause text := p_cause;
  v_offering_ended boolean := false;
  v_should_keep boolean := coalesce(p_keep_order, false);
begin
  select id, user_id, status, payment_status, final_amount, course_offering_id,
         refunded_amount, refunded_event_ids
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if p_payment_event_id = any(v_order.refunded_event_ids)
     or exists (
       select 1 from public.dead_letters
       where payload->>'handler' = 'on_payment_refunded'
         and payload->>'payment_event_id' = p_payment_event_id::text
     ) then
    return;
  end if;

  if v_order.status = 'CANCELLED'
     and v_order.payment_status is distinct from 'PARTIALLY_REFUNDED'
     and p_cause is distinct from 'POST_CLOSE_REFUND' then
    insert into public.dead_letters (source, payload, error_message)
    values (
      p_provider,
      jsonb_build_object('handler', 'on_payment_refunded', 'payment_event_id', p_payment_event_id, 'order_id', v_order.id),
      '이미 취소된 주문(탈퇴 등)에 환불 이벤트가 들어옴(상태 반영 안 함, 대사 확인 필요) — order_id='
        || v_order.id::text || ', payment_event_id=' || p_payment_event_id::text
    );
    return;
  end if;

  if v_order.payment_status not in ('PAID', 'PARTIALLY_REFUNDED') then
    insert into public.dead_letters (source, payload, error_message)
    values (
      p_provider,
      jsonb_build_object('handler', 'on_payment_refunded', 'payment_event_id', p_payment_event_id, 'order_id', v_order.id),
      '결제완료 상태가 아닌 신청 건에 환불 이벤트가 들어옴(상태 반영 안 함) — order_id='
        || v_order.id::text
        || ', payment_status=' || coalesce(v_order.payment_status, 'null')
        || ', payment_event_id=' || p_payment_event_id::text
    );
    return;
  end if;

  v_new_total := v_order.refunded_amount + coalesce(p_amount, 0);

  if p_currency is distinct from 'KRW'
     or p_amount is null or p_amount <= 0
     or v_order.final_amount is null
     or v_new_total > v_order.final_amount then
    insert into public.dead_letters (source, payload, error_message)
    values (
      p_provider,
      jsonb_build_object('handler', 'on_payment_refunded', 'payment_event_id', p_payment_event_id, 'order_id', v_order.id),
      '환불 금액을 반영할 수 없음(통화 불일치·0 이하·환불 누적 금액 초과 — 상태 반영 안 함, 대사 확인 필요) — order_id='
        || v_order.id::text
        || ', 결제액=' || coalesce(v_order.final_amount::text, 'null')
        || ', 기존 환불 누적=' || v_order.refunded_amount::text
        || ', 이번 환불=' || coalesce(p_amount::text, 'null')
        || ', currency=' || coalesce(p_currency, 'null')
        || ', payment_event_id=' || p_payment_event_id::text
    );
    return;
  end if;

  if v_order.status <> 'CANCELLED' and v_effective_cause = 'POST_CLOSE_REFUND' then
    v_effective_cause := 'ADMIN_REFUND';
  end if;

  if v_order.course_offering_id is not null then
    select (ended_at is not null) into v_offering_ended
    from public.course_offerings
    where id = v_order.course_offering_id;
  end if;

  v_partial := v_new_total < v_order.final_amount;

  -- 수강 유지 부분 환불(v_should_keep = true 및 v_partial = true)인 경우:
  -- orders.status 는 APPROVED 유지! 좌석 반환 없음, 이용권/디스코드 회수(ORDER_REFUNDED outbox) 없음.
  if v_should_keep and v_partial and v_order.status = 'APPROVED' then
    update public.orders
    set payment_status = 'PARTIALLY_REFUNDED',
        refunded_amount = v_new_total,
        refunded_event_ids = refunded_event_ids || p_payment_event_id
    where id = v_order.id;

    insert into public.order_events (event_type, actor, order_id, payload)
    values (
      'REFUND_APPLIED', 'SYSTEM', v_order.id,
      jsonb_build_object(
        'cause', coalesce(v_effective_cause, 'SESSION_COMPENSATION'),
        'reason', p_reason,
        'refund_amount', p_amount,
        'refunded_total', v_new_total,
        'final_amount', v_order.final_amount,
        'keep_order', true,
        'offering_ended', v_offering_ended
      )
    );
    return;
  end if;

  -- 그 외 일반 환불 (기존 로직: orders.status = CANCELLED)
  update public.orders
  set payment_status = case when v_partial then 'PARTIALLY_REFUNDED' else 'REFUNDED' end,
      refunded_at = case when v_partial then refunded_at else now() end,
      refunded_amount = v_new_total,
      refunded_event_ids = refunded_event_ids || p_payment_event_id,
      status = 'CANCELLED',
      cancelled_at = coalesce(cancelled_at, now())
  where id = v_order.id;

  if v_order.status is distinct from 'CANCELLED' and v_order.status is distinct from 'REJECTED' then
    if v_order.course_offering_id is not null then
      select s.first_date, s.total_count, s.past_count
        into v_first_class_date, v_total_sessions, v_past_sessions
      from public.offering_session_stats(v_order.course_offering_id) s;
      if v_first_class_date is null then
        select (opens_at at time zone 'Asia/Seoul')::date into v_first_class_date
        from public.course_offerings
        where id = v_order.course_offering_id;
      end if;
    end if;

    insert into public.order_events (event_type, actor, order_id, payload)
    values (
      'CANCELLED', 'SYSTEM', v_order.id,
      jsonb_build_object(
        'cause', v_effective_cause,
        'reason', p_reason,
        'refund_amount', p_amount,
        'refunded_total', v_new_total,
        'final_amount', v_order.final_amount,
        'partial', v_partial,
        'first_class_date', v_first_class_date,
        'total_sessions', v_total_sessions,
        'past_sessions', v_past_sessions,
        'offering_ended', v_offering_ended
      )
    );

    if v_order.course_offering_id is not null then
      perform public.release_course_offering_seat(v_order.course_offering_id);
    end if;

    insert into public.outbox_messages (topic, payload)
    values (
      'ORDER_REFUNDED',
      jsonb_build_object('order_id', v_order.id, 'user_id', v_order.user_id, 'payment_event_id', p_payment_event_id)
    );
  else
    insert into public.order_events (event_type, actor, order_id, payload)
    values (
      'REFUND_APPLIED', 'SYSTEM', v_order.id,
      jsonb_build_object(
        'cause', v_effective_cause,
        'reason', p_reason,
        'refund_amount', p_amount,
        'refunded_total', v_new_total,
        'final_amount', v_order.final_amount,
        'offering_ended', v_offering_ended
      ) || case when v_effective_cause = 'POST_CLOSE_REFUND'
             then jsonb_build_object('post_close', true)
             else '{}'::jsonb end
    );
  end if;
end;
$function$;

revoke execute on function public.on_payment_refunded(uuid, uuid, text, integer, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.on_payment_refunded(uuid, uuid, text, integer, text, text, text, boolean) to service_role;
