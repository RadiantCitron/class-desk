-- =====================================================================
-- 설계된 예외 경로 (A: 종결 주문 사후 환불, C: 지난 회차 정정)
-- 1. order_events에 REFUND_APPLIED 이벤트 종류 추가
-- 2. course_offering_events에 SESSION_CORRECTED, MANUAL_CORRECTION 이벤트 종류 추가
-- 3. session_has_started(p_date, p_start): 시작 시각 기준 판정 함수 신설
-- 4. correct_past_session: 시작된 회차 정정 함수 신설 (service_role 전용)
-- 5. begin_refund_request: p_post_close 인자 추가 (종결 후 환불 표지)
-- 6. record_payment_event: POST_CLOSE_REFUND 원인 판정
-- 7. on_payment_refunded: POST_CLOSE_REFUND 허용 및 REFUND_APPLIED 사건 기록
-- =====================================================================

-- 1. order_events 이벤트 종류에 REFUND_APPLIED 추가
alter table public.order_events drop constraint if exists order_events_event_type_check;
alter table public.order_events
  add constraint order_events_event_type_check
    check (event_type = any (array[
      'APPLIED', 'APPROVED', 'REJECTED', 'CANCELLED', 'ACCESS_GRANTED', 'CLOSED', 'REFUND_REQUESTED', 'REFUND_REQUEST_REJECTED',
      'SCHEDULE_CHANGE_NOTICE', 'SCHEDULE_CHANGE_ACCEPTED', 'SCHEDULE_CHANGE_DECLINED',
      'REFUND_APPLIED'
    ]));

-- 2. course_offering_events 이벤트 종류에 SESSION_CORRECTED, MANUAL_CORRECTION 추가
alter table public.course_offering_events drop constraint if exists course_offering_events_event_type_check;
alter table public.course_offering_events
  add constraint course_offering_events_event_type_check
    check (event_type in (
      'CREATED', 'UPDATED', 'STATUS_CHANGED', 'CANCEL_STARTED', 'CANCEL_COMPLETED',
      'ENDED', 'END_CANCELLED', 'DELETED', 'SESSION_ADDED', 'SESSION_CANCELLED', 'SCHEDULE_CHANGED',
      'SESSION_CORRECTED', 'MANUAL_CORRECTION'
    ));

-- 3. session_has_started: 시작 시각 정의 한 곳 (개정 2)
create or replace function public.session_has_started(p_date date, p_start time)
returns boolean
language sql
stable
set search_path to 'public'
as $$
  select ((p_date + p_start) at time zone 'Asia/Seoul') <= now();
$$;

grant execute on function public.session_has_started(date, time) to authenticated, service_role;
revoke execute on function public.session_has_started(date, time) from public, anon;

-- 4. correct_past_session: 지난 회차 기록 정정 (ORDER 모듈 소유, DEFINER, service_role 전용)
create or replace function public.correct_past_session(
  p_session_id uuid,
  p_date date,
  p_start time,
  p_end time,
  p_actor_id uuid,
  p_actor_role text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_session record;
  v_new_session_id uuid;
  v_active_count integer;
begin
  if p_actor_role <> 'ADMIN' then
    raise exception '관리자만 지난 회차를 정정할 수 있습니다.';
  end if;
  if p_actor_id is null then
    raise exception '행위자 ID가 필요합니다.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '정정 사유를 입력해야 합니다.';
  end if;

  select cs.id, cs.course_offering_id, cs.session_date, cs.start_time, cs.end_time, cs.deactivated_at,
         co.status as offering_status, co.deleted_at as offering_deleted_at
    into v_session
  from public.course_sessions cs
  join public.course_offerings co on co.id = cs.course_offering_id
  where cs.id = p_session_id;

  if v_session.id is null then
    raise exception '존재하지 않는 회차입니다.';
  end if;
  if v_session.deactivated_at is not null then
    raise exception '이미 비활성화된 회차입니다.';
  end if;
  if v_session.offering_deleted_at is not null then
    raise exception '삭제된 개설강의의 회차는 정정할 수 없습니다.';
  end if;
  if v_session.offering_status = 'CANCELLED' then
    raise exception '폐강된 개설강의의 회차는 정정할 수 없습니다.';
  end if;

  if not public.session_has_started(v_session.session_date, v_session.start_time) then
    raise exception '아직 시작하지 않은 회차는 일정 변경으로 바꾸세요.';
  end if;

  if not public.session_has_started(p_date, p_start) then
    raise exception '정정할 회차의 시각은 이미 시작된 시각이어야 합니다(시작 전 시각은 일정 변경으로).';
  end if;

  if p_start >= p_end then
    raise exception '종료 시각은 시작 시각보다 뒤여야 합니다.';
  end if;

  if v_session.session_date = p_date and v_session.start_time = p_start and v_session.end_time = p_end then
    raise exception '정정 전과 후의 일정이 동일합니다.';
  end if;

  perform set_config('app.skip_last_session_guard', '1', true);

  update public.course_sessions
  set deactivated_at = clock_timestamp(),
      deactivated_reason = '기록 정정: ' || p_reason
  where id = p_session_id;

  insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
  values (v_session.course_offering_id, p_date, p_start, p_end)
  returning id into v_new_session_id;

  select count(*) into v_active_count
  from public.course_sessions
  where course_offering_id = v_session.course_offering_id and deactivated_at is null;

  if v_active_count < 1 then
    raise exception '활성 회차가 1개 이상이어야 합니다.';
  end if;

  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason,
    before, after
  ) values (
    v_session.course_offering_id,
    'SESSION_CORRECTED',
    'ADMIN',
    p_actor_id,
    p_reason,
    jsonb_build_object(
      'session_id', v_session.id,
      'session_date', v_session.session_date,
      'start_time', v_session.start_time::text,
      'end_time', v_session.end_time::text
    ),
    jsonb_build_object(
      'session_id', v_new_session_id,
      'session_date', p_date,
      'start_time', p_start::text,
      'end_time', p_end::text
    )
  );

  return v_new_session_id;
end;
$function$;

revoke execute on function public.correct_past_session(uuid, date, time, time, uuid, text, text) from public, anon, authenticated;
grant execute on function public.correct_past_session(uuid, date, time, time, uuid, text, text) to service_role;

-- 5. begin_refund_request — p_post_close 인자 추가 (8인자)
drop function if exists public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid);

create or replace function public.begin_refund_request(
  p_order_id uuid,
  p_request_key text,
  p_amount integer,
  p_reason text,
  p_source text,
  p_student_request_event_id uuid default null::uuid,
  p_schedule_change_notice_event_id uuid default null::uuid,
  p_post_close boolean default false
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
as $function$
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
      || case when p_student_request_event_id is not null
           then jsonb_build_object('student_request_event_id', p_student_request_event_id)
           else '{}'::jsonb end
      || case when p_schedule_change_notice_event_id is not null
           then jsonb_build_object('schedule_change_notice_event_id', p_schedule_change_notice_event_id)
           else '{}'::jsonb end
      || case when p_post_close is true
           then jsonb_build_object('post_close', true)
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
$function$;

revoke execute on function public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean) to service_role;

-- 6. record_payment_event: POST_CLOSE_REFUND 원인 판정
drop function if exists public.record_payment_event(text, text, text, text, integer, text, uuid, text, jsonb, jsonb);

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
as $function$
declare
  v_event_id uuid;
  v_cause text;
  v_reason text;
  v_req record;
begin
  if p_order_id is null then
    raise exception '존재하지 않는 주문: %', p_order_id;
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
      else
        v_cause := 'ADMIN_REFUND';
      end if;
      v_reason := p_metadata->>'reason';
    else
      select pe.metadata->>'source' as source, pe.metadata->>'reason' as reason,
             pe.metadata->>'student_request_event_id' as student_request_event_id,
             pe.metadata->>'schedule_change_notice_event_id' as schedule_change_notice_event_id,
             (pe.metadata->>'post_close')::boolean as post_close
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
        v_cause := case
          when v_req.schedule_change_notice_event_id is not null then 'SCHEDULE_CHANGE'
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
$function$;

-- 7. on_payment_refunded: POST_CLOSE_REFUND 허용 및 REFUND_APPLIED 사건 기록
create or replace function public.on_payment_refunded(
  p_payment_event_id uuid,
  p_order_id uuid,
  p_provider text,
  p_amount integer,
  p_currency text,
  p_cause text default null::text,
  p_reason text default null::text
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

  -- 이미 취소된 주문(탈퇴 등)에 환불이 뒤늦게 오면 금액을 반영하지 않고 DLQ로 보낸다(§17-12).
  -- 단, 앞선 부분 환불로 끝난 주문(PARTIALLY_REFUNDED) 또는 종결 후 환불(POST_CLOSE_REFUND)은
  -- 정상 반영한다.
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

  -- status가 살아 있는데(APPROVED) 원인이 POST_CLOSE_REFUND이면 일반 환불(ADMIN_REFUND)로 안전하게 해석(F-7 2-1)
  if v_order.status <> 'CANCELLED' and v_effective_cause = 'POST_CLOSE_REFUND' then
    v_effective_cause := 'ADMIN_REFUND';
  end if;

  v_partial := v_new_total < v_order.final_amount;

  update public.orders
  set payment_status = case when v_partial then 'PARTIALLY_REFUNDED' else 'REFUNDED' end,
      refunded_at = case when v_partial then refunded_at else now() end,
      refunded_amount = v_new_total,
      refunded_event_ids = refunded_event_ids || p_payment_event_id,
      status = 'CANCELLED',
      cancelled_at = coalesce(cancelled_at, now())
  where id = v_order.id;

  -- 주문이 처음 끝날 때: CANCELLED 주문 사건, 좌석 반환, ORDER_REFUNDED 아웃박스
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
        'past_sessions', v_past_sessions
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
    -- 이미 종결된 주문의 사후 환불 또는 부분 환불 후 추가 환불(F-7 A & A'):
    -- 상태·좌석·혜택은 불변이고, REFUND_APPLIED 사건을 기록한다.
    insert into public.order_events (event_type, actor, order_id, payload)
    values (
      'REFUND_APPLIED', 'SYSTEM', v_order.id,
      jsonb_build_object(
        'cause', v_effective_cause,
        'reason', p_reason,
        'refund_amount', p_amount,
        'refunded_total', v_new_total,
        'final_amount', v_order.final_amount
      ) || case when v_effective_cause = 'POST_CLOSE_REFUND'
             then jsonb_build_object('post_close', true)
             else '{}'::jsonb end
    );
  end if;
end;
$function$;
