-- 수강생이 있는 수업의 일정 변경 + 안내·동의 + 무응답·미동의 처리.
--
--  · order_events 이벤트 종류에 SCHEDULE_CHANGE_NOTICE(안내)·SCHEDULE_CHANGE_ACCEPTED·SCHEDULE_CHANGE_DECLINED(수강생 응답)를 더한다. 새 테이블·승인 엔진·타이머 없음.
--    현재 상태 = **가장 최근 안내**에 대한 응답(없으면 대기). 일정이 또 바뀌면 새 안내가 이전 응답을 대체한다. TS 정의: lib/shared/schedule-change.ts.
--    안내·응답 이벤트의 created_at은 clock_timestamp()로 넣는다 — 같은 트랜잭션에서도 순서가 구분된다.
--  · apply_schedule_change: 개강 전에 한해 한 트랜잭션에서 회차를 취소·추가하고(S-1의 겹침 제약·계산 캐시 트리거 적용), 살아 있는(승인 대기·승인됨) 주문마다
--    안내 1건을 남긴다. 변경 후 활성 회차 1개 이상·첫 회차가 미래·변경 결과가 달라야 한다. 취소→추가 사이에 마지막 활성 회차 보호 트리거가 걸리지 않게
--    트랜잭션 로컬 설정(app.skip_last_session_guard)으로 건너뛰고 끝에 직접 확인한다.
--  · respond_schedule_change: 본인 주문의 **가장 최근 안내**에 한 번만 응답(번복 불가).
--  · exclude_order_for_schedule_change: 응답이 「동의」가 아닌 열린 안내가 있는 **미결제·무료** 주문을 환불 없이 제외(CANCELLED, 취소 사건 원인 SCHEDULE_CHANGE, 좌석 반환,
--    ORDER_CLOSED 사실로 이용권·디스코드 역할 회수). 결제 완료 건은 거부한다 — 카드는 PG 환불 경로로(begin_refund_request의 새 선택 인자), 그 밖은 PG 외 환불 반영으로.
--  · begin_refund_request: 7번째 선택 인자 p_schedule_change_notice_event_id를 결제 원장 메타데이터에 싣고, record_payment_event가 그 값이 있으면 환불 원인을
--    SCHEDULE_CHANGE로 정한다(학생 신청 연결 STUDENT_REFUND보다 우선). 6인자 함수는 교체한다(기본값 null이라 옛 호출은 그대로 동작).
--  역할은 호출자가 레일로 확인한 값을 인자로 받는다(주문 모듈은 users를 읽지 않는다 — R1). 새 시그니처 grant는 같은 파일에.

-- 1. 이벤트 종류
alter table public.order_events drop constraint order_events_event_type_check;
alter table public.order_events
  add constraint order_events_event_type_check
    check (event_type = any (array[
      'APPLIED', 'APPROVED', 'REJECTED', 'CANCELLED', 'ACCESS_GRANTED', 'CLOSED', 'REFUND_REQUESTED', 'REFUND_REQUEST_REJECTED',
      'SCHEDULE_CHANGE_NOTICE', 'SCHEDULE_CHANGE_ACCEPTED', 'SCHEDULE_CHANGE_DECLINED'
    ]));

-- 2. 마지막 활성 회차 보호 — 일정 변경 중에만 건너뜀
CREATE OR REPLACE FUNCTION public.guard_last_active_session()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  -- apply_schedule_change가 한 트랜잭션 안에서 회차를 취소하고 새 회차를 더하는 동안만 건너뛴다(끝에 활성 회차가 1개 이상인지 직접 확인한다).
  if current_setting('app.skip_last_session_guard', true) = '1' then
    return new;
  end if;
  if old.deactivated_at is null and new.deactivated_at is not null then
    if not exists (
         select 1 from public.course_offerings o
         where o.id = new.course_offering_id and o.deleted_at is not null
       )
       and not exists (
         select 1 from public.course_sessions s
         where s.course_offering_id = new.course_offering_id
           and s.deactivated_at is null
           and s.id <> new.id
       ) then
      raise exception '마지막 남은 회차는 취소할 수 없습니다. 수업 전체를 폐강하거나 삭제하세요.';
    end if;
  end if;
  return new;
end;
$function$;

-- 3. 일정 변경
create function public.apply_schedule_change(
  p_offering_id uuid,
  p_actor uuid,
  p_actor_role text,
  p_reason text,
  p_cancel_session_ids uuid[],
  p_add_sessions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_off public.course_offerings%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_cancel uuid[] := coalesce(p_cancel_session_ids, '{}'::uuid[]);
  v_add jsonb := coalesce(p_add_sessions, '[]'::jsonb);
  v_before jsonb;
  v_after jsonb;
  v_change_id uuid := gen_random_uuid();
  v_valid integer;
  v_distinct integer;
  v_new_opens timestamptz;
  v_notified jsonb := '[]'::jsonb;
  v_order record;
  v_notice_id uuid;
begin
  if p_actor is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 일정을 변경할 수 있습니다.';
  end if;
  if v_reason = '' then
    raise exception '변경 사유를 입력해야 합니다.';
  end if;

  select * into v_off from public.course_offerings where id = p_offering_id for update;
  if not found then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_off.deleted_at is not null then
    raise exception '삭제된 개설강의의 일정은 바꿀 수 없습니다.';
  end if;
  if v_off.status not in ('OPEN', 'CLOSED') then
    raise exception '폐강된 개설강의의 일정은 바꿀 수 없습니다.';
  end if;
  if v_off.ended_at is not null then
    raise exception '종료된 개설강의의 일정은 바꿀 수 없습니다.';
  end if;
  if v_off.opens_at <= now() then
    raise exception '개강한 수업의 일정은 바꿀 수 없습니다.';
  end if;

  if jsonb_typeof(v_add) <> 'array' then
    raise exception '추가할 회차 목록(배열)이 필요합니다.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_add) e
    where jsonb_typeof(e) <> 'object'
       or not (e ? 'date' and e ? 'start' and e ? 'end')
       or jsonb_typeof(e -> 'date') <> 'string'
       or jsonb_typeof(e -> 'start') <> 'string'
       or jsonb_typeof(e -> 'end') <> 'string'
  ) then
    raise exception '회차는 {"date","start","end"} 객체여야 합니다.';
  end if;
  if cardinality(v_cancel) = 0 and jsonb_array_length(v_add) = 0 then
    raise exception '변경할 내용이 없습니다.';
  end if;
  if jsonb_array_length(v_add) > 100 then
    raise exception '회차는 최대 100개까지 추가할 수 있습니다.';
  end if;

  select count(distinct x) into v_distinct from unnest(v_cancel) x;
  select count(*) into v_valid
  from public.course_sessions
  where id = any (v_cancel) and course_offering_id = p_offering_id and deactivated_at is null;
  if v_valid <> v_distinct then
    raise exception '취소할 회차가 이 수업의 활성 회차가 아닙니다.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('date', session_date, 'start', to_char(start_time, 'HH24:MI'), 'end', to_char(end_time, 'HH24:MI'))
                            order by session_date, start_time), '[]'::jsonb)
    into v_before
  from public.course_sessions
  where course_offering_id = p_offering_id and deactivated_at is null;

  perform set_config('app.skip_last_session_guard', '1', true);
  update public.course_sessions
  set deactivated_at = now(), deactivated_reason = v_reason
  where id = any (v_cancel);

  begin
    insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
    select p_offering_id, (e ->> 'date')::date, (e ->> 'start')::time, (e ->> 'end')::time
    from jsonb_array_elements(v_add) e;
  exception when check_violation then
    perform set_config('app.skip_last_session_guard', '', true);
    if sqlerrm like '%course_offerings_recruit_before_opens%' then
      raise exception '모집 시작은 개강(첫 회차 시작)보다 앞이어야 합니다.';
    end if;
    raise;
  end;
  perform set_config('app.skip_last_session_guard', '', true);

  if not exists (select 1 from public.course_sessions where course_offering_id = p_offering_id and deactivated_at is null) then
    raise exception '변경 후 활성 회차가 1개 이상 있어야 합니다.';
  end if;

  select opens_at into v_new_opens from public.course_offerings where id = p_offering_id;
  if v_new_opens <= now() then
    raise exception '변경 후 첫 회차가 이미 지난 시각입니다. 미래 날짜로 지정해 주세요.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('date', session_date, 'start', to_char(start_time, 'HH24:MI'), 'end', to_char(end_time, 'HH24:MI'))
                            order by session_date, start_time), '[]'::jsonb)
    into v_after
  from public.course_sessions
  where course_offering_id = p_offering_id and deactivated_at is null;

  if v_before = v_after then
    raise exception '변경 결과가 기존 일정과 같습니다.';
  end if;

  for v_order in
    select o.id, o.user_id from public.orders o
    where o.course_offering_id = p_offering_id and o.status in ('PENDING', 'APPROVED')
    order by o.created_at, o.id
  loop
    insert into public.order_events (event_type, actor, actor_user_id, order_id, payload, created_at)
    values (
      'SCHEDULE_CHANGE_NOTICE', 'ADMIN', p_actor, v_order.id,
      jsonb_build_object('change_id', v_change_id, 'reason', v_reason, 'before', v_before, 'after', v_after),
      clock_timestamp()
    )
    returning id into v_notice_id;
    v_notified := v_notified || jsonb_build_array(
      jsonb_build_object('order_id', v_order.id, 'user_id', v_order.user_id, 'notice_event_id', v_notice_id));
  end loop;

  return jsonb_build_object('change_id', v_change_id, 'notified', v_notified);
end;
$$;

-- 4. 수강생 응답 — 가장 최근 안내에 한 번만
create function public.respond_schedule_change(
  p_order_id uuid,
  p_user_id uuid,
  p_notice_event_id uuid,
  p_accept boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_latest uuid;
  v_change_id text;
  v_event_id uuid;
begin
  select id, user_id, status into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.user_id is distinct from p_user_id then
    raise exception '내 신청 건이 아닙니다.';
  end if;
  if v_order.status not in ('PENDING', 'APPROVED') then
    raise exception '이미 종료된 신청 건입니다.';
  end if;
  if p_accept is null then
    raise exception '동의 여부를 선택해야 합니다.';
  end if;

  select e.id, e.payload->>'change_id' into v_latest, v_change_id
  from public.order_events e
  where e.order_id = p_order_id and e.event_type = 'SCHEDULE_CHANGE_NOTICE'
  order by e.created_at desc, e.id desc
  limit 1;
  if v_latest is null or v_latest is distinct from p_notice_event_id then
    raise exception '응답할 수 있는 일정 변경 안내가 아닙니다. 화면을 새로고침해 주세요.';
  end if;

  if exists (
    select 1 from public.order_events r
    where r.order_id = p_order_id
      and r.event_type in ('SCHEDULE_CHANGE_ACCEPTED', 'SCHEDULE_CHANGE_DECLINED')
      and r.payload->>'notice_event_id' = v_latest::text
  ) then
    raise exception '이미 응답했습니다. 응답은 바꿀 수 없습니다.';
  end if;

  insert into public.order_events (event_type, actor, actor_user_id, order_id, payload, created_at)
  values (
    case when p_accept then 'SCHEDULE_CHANGE_ACCEPTED' else 'SCHEDULE_CHANGE_DECLINED' end,
    'STUDENT', p_user_id, p_order_id,
    jsonb_build_object('notice_event_id', v_latest, 'change_id', v_change_id),
    clock_timestamp()
  )
  returning id into v_event_id;
  return v_event_id;
end;
$$;

-- 5. 환불 없는 제외(미결제·무료)
create function public.exclude_order_for_schedule_change(
  p_order_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_notice uuid;
  v_notice_change text;
  v_event_id uuid;
  v_first date;
  v_total integer;
  v_past integer;
begin
  if p_actor_id is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 일정 변경으로 인한 제외 처리를 할 수 있습니다.';
  end if;
  if v_reason = '' then
    raise exception '제외 사유를 입력해야 합니다.';
  end if;

  select id, user_id, status, payment_status, course_offering_id into v_order
  from public.orders where id = p_order_id for update;
  if not found then
    raise exception '신청 건을 찾을 수 없습니다.';
  end if;
  if v_order.status not in ('PENDING', 'APPROVED') then
    raise exception '이미 종료된 신청 건입니다.';
  end if;
  if v_order.payment_status in ('PAID', 'PARTIALLY_REFUNDED') then
    raise exception '결제가 완료된 신청 건은 환불 경로로 처리합니다(카드는 환불 요청, 그 밖의 결제는 PG 외 환불 반영).';
  end if;

  select e.id, e.payload->>'change_id' into v_notice, v_notice_change
  from public.order_events e
  where e.order_id = p_order_id and e.event_type = 'SCHEDULE_CHANGE_NOTICE'
  order by e.created_at desc, e.id desc
  limit 1;
  if v_notice is null then
    raise exception '일정 변경 안내가 없는 신청 건은 이 방법으로 제외할 수 없습니다.';
  end if;
  if exists (
    select 1 from public.order_events r
    where r.order_id = p_order_id and r.event_type = 'SCHEDULE_CHANGE_ACCEPTED' and r.payload->>'notice_event_id' = v_notice::text
  ) then
    raise exception '변경된 일정에 동의한 수강생은 제외할 수 없습니다.';
  end if;

  if v_order.course_offering_id is not null then
    select s.first_date, s.total_count, s.past_count into v_first, v_total, v_past
    from public.offering_session_stats(v_order.course_offering_id) s;
  end if;

  update public.orders set status = 'CANCELLED', cancelled_at = coalesce(cancelled_at, now()) where id = p_order_id;

  insert into public.order_events (event_type, actor, actor_user_id, order_id, payload)
  values (
    'CANCELLED', 'ADMIN', p_actor_id, p_order_id,
    jsonb_build_object(
      'cause', 'SCHEDULE_CHANGE', 'reason', v_reason, 'mode', 'NO_REFUND',
      'notice_event_id', v_notice, 'change_id', v_notice_change,
      'total_sessions', v_total, 'past_sessions', v_past, 'first_class_date', v_first
    )
  )
  returning id into v_event_id;

  if v_order.course_offering_id is not null then
    perform public.release_course_offering_seat(v_order.course_offering_id);
  end if;

  insert into public.outbox_messages (topic, payload)
  values ('ORDER_CLOSED', jsonb_build_object('order_id', p_order_id, 'user_id', v_order.user_id, 'close_event_id', v_event_id));

  return v_event_id;
end;
$$;

revoke execute on function public.apply_schedule_change(uuid, uuid, text, text, uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.apply_schedule_change(uuid, uuid, text, text, uuid[], jsonb) to service_role;
revoke execute on function public.respond_schedule_change(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.respond_schedule_change(uuid, uuid, uuid, boolean) to service_role;
revoke execute on function public.exclude_order_for_schedule_change(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.exclude_order_for_schedule_change(uuid, uuid, text, text) to service_role;

-- 6. begin_refund_request — 일정 변경 연결(선택 인자)
drop function public.begin_refund_request(uuid, text, integer, text, text, uuid);

CREATE OR REPLACE FUNCTION public.begin_refund_request(p_order_id uuid, p_request_key text, p_amount integer, p_reason text, p_source text, p_student_request_event_id uuid DEFAULT NULL::uuid, p_schedule_change_notice_event_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, request_event_id uuid, provider text, provider_transaction_id text, refundable integer, payment_amount integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    jsonb_build_object('reason', p_reason, 'source', p_source, 'request_key', p_request_key)
      || case when p_student_request_event_id is not null
           then jsonb_build_object('student_request_event_id', p_student_request_event_id)
           else '{}'::jsonb end
      || case when p_schedule_change_notice_event_id is not null
           then jsonb_build_object('schedule_change_notice_event_id', p_schedule_change_notice_event_id)
           else '{}'::jsonb end,
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
$function$;

revoke execute on function public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid) to service_role;

-- 7. record_payment_event — 환불 원인 SCHEDULE_CHANGE
CREATE OR REPLACE FUNCTION public.record_payment_event(p_provider text, p_provider_event_id text, p_event_type text, p_amount integer, p_currency text, p_order_id uuid, p_payment_method text, p_metadata jsonb, p_raw_payload jsonb, p_provider_transaction_id text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- 환불 원인: PG 외 환불 반영 > 아직 닫히지 않은 우리 환불 요청의 출처 > 요청 없는 외부 취소
    if p_metadata->>'source' = 'ADMIN_MANUAL_REFUND' then
      v_cause := 'ADMIN_REFUND';
      v_reason := p_metadata->>'reason';
    else
      select pe.metadata->>'source' as source, pe.metadata->>'reason' as reason,
             pe.metadata->>'student_request_event_id' as student_request_event_id,
             pe.metadata->>'schedule_change_notice_event_id' as schedule_change_notice_event_id
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

      if v_req.source = 'ADMIN' then
        -- 학생의 환불 신청에서 시작된 관리자 환불이면 원인을 구분한다 — 라벨 「수강 포기」의 근거는 같지만 누가 시작했는지가 다르다.
        -- 일정 변경 미동의·무응답 처리에서 시작된 환불은 SCHEDULE_CHANGE, 학생 신청에서 시작되면 STUDENT_REFUND.
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

-- 8. S-2의 개별 추가·취소 거부 문구 정정 — 신청자가 있는 수업은 이제 「일정 변경」(안내·동의)으로 바꾼다.
CREATE OR REPLACE FUNCTION public.assert_course_sessions_editable(p_offering_id uuid, p_actor uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_off public.course_offerings%rowtype;
begin
  if p_actor is null then
    raise exception '행위자가 필요합니다.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '사유를 입력해야 합니다.';
  end if;

  select * into v_off from public.course_offerings where id = p_offering_id for update;
  if not found then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_off.deleted_at is not null then
    raise exception '삭제된 개설강의의 일정은 바꿀 수 없습니다.';
  end if;
  if v_off.status not in ('OPEN', 'CLOSED') then
    raise exception '폐강된 개설강의의 일정은 바꿀 수 없습니다.';
  end if;
  if v_off.ended_at is not null then
    raise exception '종료된 개설강의의 일정은 바꿀 수 없습니다.';
  end if;
  if v_off.opens_at <= now() then
    raise exception '개강한 수업의 일정은 바꿀 수 없습니다.';
  end if;
  if exists (
    select 1 from public.orders o
    where o.course_offering_id = p_offering_id and o.status in ('PENDING', 'APPROVED')
  ) then
    raise exception '신청(승인 대기·승인됨)이 있는 수업은 개별 추가·취소가 아니라 「일정 변경」(수강생 안내·동의)으로 바꿔야 합니다.';
  end if;
end;
$function$;
