-- F-4: 개강 후에도 시작하지 않은 회차 변경(시작 시각 기준) + N4 개설강의 상태 확인
--
-- 변경 내역:
--   1. apply_schedule_change:
--      - 개강 전 조건(opens_at <= now() 거부) 완화: 시작 시각(session_has_started) 기준으로 분기.
--      - 취소 대상 회차는 모두 session_has_started = false (시작 전 회차만 취소 가능). 시작했거나 진행 중이면 거부.
--      - 추가 회차의 시작 시각은 모두 미래((date + start)::timestamptz at time zone 'Asia/Seoul' > now()).
--      - 변경 뒤 session_has_started = false 인 시작 전 활성 회차가 1개 이상 남아 있어야 함.
--      - opens_at <= now() 인 경우(개강 후): opens_at 은 과거이므로 첫 회차 검사는 '첫 회차가 미래'가 아니라,
--        기존 opens_at 유지 및 시작 전 회차 존재 보장. 개강 전인 경우 변경 뒤 첫 회차가 미래여야 함.
--      - 원장 SCHEDULE_CHANGED 의 after 에 started: true/false 기록.
--      - 안내 SCHEDULE_CHANGE_NOTICE payload 에 started: true/false 기록.
--   2. respond_schedule_change:
--      - N4: 개설강의가 종료(ended_at is not null)이거나 폐강 진행/완료(status in ('CANCELLING', 'CANCELLED'))이면 거부.
--   3. exclude_order_for_schedule_change:
--      - N4: 개설강의가 종료(ended_at is not null)이거나 폐강 진행/완료(status in ('CANCELLING', 'CANCELLED'))이면 거부.

-- =====================================================================
-- 1. apply_schedule_change
-- =====================================================================
create or replace function public.apply_schedule_change(
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
  v_added_ids uuid[] := '{}'::uuid[];
  v_notified_count integer := 0;
  v_started boolean := false;
  v_cancel_started_count integer;
  v_elem jsonb;
  v_elem_date date;
  v_elem_start time;
  v_elem_end time;
  v_elem_ts timestamptz;
  v_future_active_count integer;
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

  -- 개강 여부 판정: 첫 회차 시작 시각(opens_at) 기준
  v_started := (v_off.opens_at <= now());

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

  -- 취소 대상 회차 유효성 확인
  select count(distinct x) into v_distinct from unnest(v_cancel) x;
  select count(*) into v_valid
  from public.course_sessions
  where id = any (v_cancel) and course_offering_id = p_offering_id and deactivated_at is null;
  if v_valid <> v_distinct then
    raise exception '취소할 회차가 이 수업의 활성 회차가 아닙니다.';
  end if;

  -- 취소 대상 회차는 모두 시작 전이어야 함 (session_has_started = false)
  select count(*) into v_cancel_started_count
  from public.course_sessions
  where id = any (v_cancel)
    and public.session_has_started(session_date, start_time);

  if v_cancel_started_count > 0 then
    raise exception '이미 시작한 회차는 바꿀 수 없습니다.';
  end if;

  -- 추가 회차의 시작 시각은 모두 미래여야 함
  for v_elem in select * from jsonb_array_elements(v_add) loop
    v_elem_date := (v_elem ->> 'date')::date;
    v_elem_start := (v_elem ->> 'start')::time;
    v_elem_ts := ((v_elem_date::text || ' ' || to_char(v_elem_start, 'HH24:MI:SS'))::timestamp at time zone 'Asia/Seoul');
    if v_elem_ts <= now() then
      raise exception '추가할 회차의 시작 시각은 현재 이후여야 합니다.';
    end if;
  end loop;

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
    with inserted as (
      insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
      select p_offering_id, (e ->> 'date')::date, (e ->> 'start')::time, (e ->> 'end')::time
      from jsonb_array_elements(v_add) e
      returning id
    )
    select coalesce(array_agg(id), '{}'::uuid[]) from inserted into v_added_ids;
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

  -- 변경 뒤 시작 전 활성 회차가 1개 이상 남아 있어야 함
  select count(*) into v_future_active_count
  from public.course_sessions
  where course_offering_id = p_offering_id
    and deactivated_at is null
    and not public.session_has_started(session_date, start_time);

  if v_future_active_count = 0 then
    raise exception '변경 후 시작하지 않은 활성 회차가 1개 이상 있어야 합니다(남은 일정이 없으면 폐강을 이용하세요).';
  end if;

  -- 개강 전 수업인 경우 변경 후 첫 회차가 미래여야 함
  select opens_at into v_new_opens from public.course_offerings where id = p_offering_id;
  if not v_started and v_new_opens <= now() then
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

  -- 원장 기록 (SCHEDULE_CHANGED): 안내에 쓰일 v_change_id를 기본키로 지정, started 필드 추가
  insert into public.course_offering_events (
    id, course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    v_change_id, p_offering_id, 'SCHEDULE_CHANGED', 'ADMIN', p_actor, v_reason,
    v_before,
    jsonb_build_object(
      'active_sessions', v_after,
      'cancelled_session_ids', to_jsonb(v_cancel),
      'added_session_ids', to_jsonb(v_added_ids),
      'notified_orders', (select count(*) from public.orders where course_offering_id = p_offering_id and status in ('PENDING', 'APPROVED')),
      'started', v_started
    ),
    clock_timestamp()
  );

  for v_order in
    select o.id, o.user_id from public.orders o
    where o.course_offering_id = p_offering_id and o.status in ('PENDING', 'APPROVED')
    order by o.created_at, o.id
  loop
    v_notified_count := v_notified_count + 1;
    insert into public.order_events (event_type, actor, actor_user_id, order_id, payload, created_at)
    values (
      'SCHEDULE_CHANGE_NOTICE', 'ADMIN', p_actor, v_order.id,
      jsonb_build_object('change_id', v_change_id, 'reason', v_reason, 'before', v_before, 'after', v_after, 'started', v_started),
      clock_timestamp()
    )
    returning id into v_notice_id;
    v_notified := v_notified || jsonb_build_array(
      jsonb_build_object('order_id', v_order.id, 'user_id', v_order.user_id, 'notice_event_id', v_notice_id));
  end loop;

  return jsonb_build_object('change_id', v_change_id, 'notified', v_notified);
end;
$$;

revoke execute on function public.apply_schedule_change(
  uuid, uuid, text, text, uuid[], jsonb
) from public, anon, authenticated;
grant execute on function public.apply_schedule_change(
  uuid, uuid, text, text, uuid[], jsonb
) to service_role;


-- =====================================================================
-- 2. respond_schedule_change (N4: 종료/폐강 개설강의 응답 거부)
-- =====================================================================
create or replace function public.respond_schedule_change(
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
  v_offering record;
  v_latest uuid;
  v_change_id text;
  v_event_id uuid;
begin
  select id, user_id, status, course_offering_id into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.user_id is distinct from p_user_id then
    raise exception '내 신청 건이 아닙니다.';
  end if;
  if v_order.status not in ('PENDING', 'APPROVED') then
    raise exception '이미 종료된 신청 건입니다.';
  end if;
  if p_accept is null then
    raise exception '동의 여부를 선택해야 합니다.';
  end if;

  if v_order.course_offering_id is not null then
    select status, ended_at into v_offering from public.course_offerings where id = v_order.course_offering_id;
    if v_offering.ended_at is not null then
      raise exception '종료된 수업의 일정 변경에는 응답할 수 없습니다.';
    end if;
    if v_offering.status in ('CANCELLING', 'CANCELLED') then
      raise exception '폐강 중인 수업의 일정 변경에는 응답할 수 없습니다.';
    end if;
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

revoke execute on function public.respond_schedule_change(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.respond_schedule_change(uuid, uuid, uuid, boolean) to service_role;


-- =====================================================================
-- 3. exclude_order_for_schedule_change (N4: 종료/폐강 개설강의 제외 거부)
-- =====================================================================
create or replace function public.exclude_order_for_schedule_change(
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
  v_offering record;
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

  if v_order.course_offering_id is not null then
    select status, ended_at into v_offering from public.course_offerings where id = v_order.course_offering_id;
    if v_offering.ended_at is not null then
      raise exception '종료된 수업의 신청 건은 일정 변경으로 제외할 수 없습니다.';
    end if;
    if v_offering.status in ('CANCELLING', 'CANCELLED') then
      raise exception '폐강 중인 수업의 신청 건은 일정 변경으로 제외할 수 없습니다. 폐강 처리로 환불하세요.';
    end if;
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

revoke execute on function public.exclude_order_for_schedule_change(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.exclude_order_for_schedule_change(uuid, uuid, text, text) to service_role;
