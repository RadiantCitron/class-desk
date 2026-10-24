-- A-1: 개설강의 공지문 (강의 조회 페이지 상단 글 하나 및 일정 변경 시 동시 게시)
--
-- 변경 내역:
--   1. course_offerings 테이블에 notice_text 컬럼 및 길이 제약(<= 1000자) 추가
--   2. set_course_offering_notice 전용 함수 신설:
--      - 관리자만 (p_actor_role = 'ADMIN')
--      - 사유 필수 (비어 있으면 거부)
--      - 상태 검증: OPEN, CLOSED, CANCELLING 허용 / CANCELLED, ended_at IS NOT NULL, deleted_at IS NOT NULL 거부
--      - 값 정규화: btrim, 빈 문자열은 null, 1000자 초과 거부, 기존 값과 동일하면 거부
--      - 원장 기록: course_offering_events 에 UPDATED 사건 (before/after notice_text)
--      - service_role 권한 부여 및 public/anon/authenticated 차단
--   3. apply_schedule_change 함수 보강:
--      - p_notice text default null, p_update_notice boolean default false 인자 추가 (기존 7인자 drop 후 9인자 신설)
--      - p_update_notice 가 참인 경우 같은 트랜잭션에서 notice_text 를 갱신하고 course_offering_events 에 UPDATED 사건 기록

-- =====================================================================
-- 1. course_offerings notice_text 컬럼 추가
-- =====================================================================
alter table public.course_offerings
  add column if not exists notice_text text;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'course_offerings' and column_name = 'notice_text'
  ) then
    alter table public.course_offerings add column notice_text text;
  end if;
end $$;

alter table public.course_offerings
  drop constraint if exists course_offerings_notice_text_len;

alter table public.course_offerings
  add constraint course_offerings_notice_text_len
    check (notice_text is null or char_length(notice_text) <= 1000);

-- =====================================================================
-- 2. set_course_offering_notice 함수 신설
-- =====================================================================
create or replace function public.set_course_offering_notice(
  p_offering_id uuid,
  p_actor uuid,
  p_actor_role text,
  p_notice text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_off public.course_offerings%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_norm_notice text;
  v_before_notice text;
begin
  if p_actor is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 공지를 수정할 수 있습니다.';
  end if;
  if v_reason = '' then
    raise exception '수정 사유를 입력해야 합니다.';
  end if;

  select * into v_off
  from public.course_offerings
  where id = p_offering_id
  for update;

  if not found then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_off.deleted_at is not null then
    raise exception '삭제된 개설강의는 수정할 수 없습니다.';
  end if;
  if v_off.status = 'CANCELLED' then
    raise exception '폐강 완료된 개설강의는 수정할 수 없습니다.';
  end if;
  if v_off.ended_at is not null then
    raise exception '종료된 강의는 수정할 수 없습니다.';
  end if;

  -- 공지 정규화: 트림, 빈 문자열은 null
  v_norm_notice := nullif(btrim(coalesce(p_notice, '')), '');
  if v_norm_notice is not null and char_length(v_norm_notice) > 1000 then
    raise exception '공지문은 최대 1,000자까지 입력할 수 있습니다.';
  end if;

  v_before_notice := v_off.notice_text;
  if v_before_notice is not distinct from v_norm_notice then
    raise exception '변경된 값이 없습니다.';
  end if;

  update public.course_offerings
  set notice_text = v_norm_notice
  where id = p_offering_id;

  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    p_offering_id, 'UPDATED', 'ADMIN', p_actor, v_reason,
    jsonb_build_object('notice_text', v_before_notice),
    jsonb_build_object('notice_text', v_norm_notice),
    clock_timestamp()
  );
end;
$$;

revoke execute on function public.set_course_offering_notice(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.set_course_offering_notice(uuid, uuid, text, text, text) to service_role;

-- =====================================================================
-- 3. apply_schedule_change (p_notice, p_update_notice 9인자 확장)
-- =====================================================================
drop function if exists public.apply_schedule_change(uuid, uuid, text, text, uuid[], jsonb);
drop function if exists public.apply_schedule_change(uuid, uuid, text, text, uuid[], jsonb, text);
drop function if exists public.apply_schedule_change(uuid, uuid, text, text, uuid[], jsonb, text, text, boolean);

create function public.apply_schedule_change(
  p_offering_id uuid,
  p_actor uuid,
  p_actor_role text,
  p_reason text,
  p_cancel_session_ids uuid[],
  p_add_sessions jsonb,
  p_location text default null,
  p_notice text default null,
  p_update_notice boolean default false
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
  v_new_location text := nullif(btrim(p_location), '');
  v_location_changed boolean := false;
  v_schedule_changed boolean := false;
  v_norm_notice text;
  v_before_notice text;
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

  -- 장소 변경 여부 확인
  if p_location is not null and v_new_location is distinct from v_off.location then
    v_location_changed := true;
  end if;

  -- 회차 변경 여부 확인
  if cardinality(v_cancel) > 0 or (jsonb_typeof(v_add) = 'array' and jsonb_array_length(v_add) > 0) then
    v_schedule_changed := true;
  end if;

  if not v_schedule_changed and not v_location_changed then
    raise exception '변경할 내용이 없습니다.';
  end if;

  -- 개강 여부 판정: 첫 회차 시작 시각(opens_at) 기준
  v_started := (v_off.opens_at <= now());

  -- 회차 변경이 있는 경우 유효성 검사 및 적용
  if v_schedule_changed then
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
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('date', session_date, 'start', to_char(start_time, 'HH24:MI'), 'end', to_char(end_time, 'HH24:MI'))
                            order by session_date, start_time), '[]'::jsonb)
    into v_before
  from public.course_sessions
  where course_offering_id = p_offering_id and deactivated_at is null;

  if v_schedule_changed then
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
  end if;

  -- 장소 변경 반영
  if v_location_changed then
    update public.course_offerings
    set location = v_new_location
    where id = p_offering_id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('date', session_date, 'start', to_char(start_time, 'HH24:MI'), 'end', to_char(end_time, 'HH24:MI'))
                            order by session_date, start_time), '[]'::jsonb)
    into v_after
  from public.course_sessions
  where course_offering_id = p_offering_id and deactivated_at is null;

  if not v_location_changed and v_before = v_after then
    raise exception '변경 결과가 기존 일정과 같습니다.';
  end if;

  -- 공지 함께 게시 (p_update_notice = true)
  if p_update_notice then
    v_norm_notice := nullif(btrim(coalesce(p_notice, '')), '');
    if v_norm_notice is not null and char_length(v_norm_notice) > 1000 then
      raise exception '공지문은 최대 1,000자까지 입력할 수 있습니다.';
    end if;

    v_before_notice := v_off.notice_text;
    if v_before_notice is distinct from v_norm_notice then
      update public.course_offerings
      set notice_text = v_norm_notice
      where id = p_offering_id;

      insert into public.course_offering_events (
        course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
      ) values (
        p_offering_id, 'UPDATED', 'ADMIN', p_actor, v_reason,
        jsonb_build_object('notice_text', v_before_notice),
        jsonb_build_object('notice_text', v_norm_notice),
        clock_timestamp()
      );
    end if;
  end if;

  -- 원장 기록 (SCHEDULE_CHANGED): 장소 변경도 포함
  insert into public.course_offering_events (
    id, course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    v_change_id, p_offering_id, 'SCHEDULE_CHANGED', 'ADMIN', p_actor, v_reason,
    jsonb_build_object(
      'active_sessions', v_before,
      'location', v_off.location
    ),
    jsonb_build_object(
      'active_sessions', v_after,
      'location', case when v_location_changed then v_new_location else v_off.location end,
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
      jsonb_build_object(
        'change_id', v_change_id,
        'reason', v_reason,
        'before', v_before,
        'after', v_after,
        'started', v_started,
        'before_location', v_off.location,
        'after_location', case when v_location_changed then v_new_location else v_off.location end
      ),
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
  uuid, uuid, text, text, uuid[], jsonb, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.apply_schedule_change(
  uuid, uuid, text, text, uuid[], jsonb, text, text, boolean
) to service_role;
