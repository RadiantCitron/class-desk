-- =====================================================================
-- 개설강의 사건 원장 (course_offering_events) 및 DEFINER 전환
-- 1. 개설강의와 회차를 변경하는 모든 DB 함수가 같은 트랜잭션에서 사건 원장에 기록한다.
-- 2. INVOKER 함수 6개를 SECURITY DEFINER + service_role 전용으로 전환한다.
-- 3. 폐강·종료·일정변경 함수에도 원장 기록 및 역할 검증을 일관되게 적용한다.
-- =====================================================================

-- 1. 원장 테이블 생성
create table public.course_offering_events (
  id uuid primary key default gen_random_uuid(),
  course_offering_id uuid not null references public.course_offerings (id) on delete restrict,
  event_type text not null check (event_type in (
    'CREATED', 'UPDATED', 'STATUS_CHANGED', 'CANCEL_STARTED', 'CANCEL_COMPLETED',
    'ENDED', 'END_CANCELLED', 'DELETED', 'SESSION_ADDED', 'SESSION_CANCELLED', 'SCHEDULE_CHANGED'
  )),
  actor text not null check (actor in ('ADMIN', 'SYSTEM')),
  actor_user_id uuid references public.users (id),
  reason text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint course_offering_events_admin_needs_actor check (
    actor <> 'ADMIN' or (actor_user_id is not null and nullif(btrim(reason), '') is not null)
  )
);

create index on public.course_offering_events (course_offering_id, created_at);

-- 불변 트리거: event_log_forbid_app_update_delete 재사용
create trigger course_offering_events_immutable
  before update or delete on public.course_offering_events
  for each row execute function public.event_log_forbid_app_update_delete();

-- RLS
alter table public.course_offering_events enable row level security;
create policy course_offering_events_select_admin
  on public.course_offering_events
  for select
  to authenticated
  using (public.is_admin());

-- 권한 명시
grant select, insert on public.course_offering_events to service_role;
grant select on public.course_offering_events to authenticated;
revoke all on public.course_offering_events from public, anon;
revoke update, delete on public.course_offering_events from authenticated;


-- =====================================================================
-- 2. create_course_offering — DEFINER 전환 및 원장 기록
-- =====================================================================
drop function if exists public.create_course_offering(
  uuid, text, integer, integer, text, text[], jsonb, timestamptz, jsonb, boolean
);

create function public.create_course_offering(
  p_course_id uuid,
  p_label text,
  p_capacity integer,
  p_price integer,
  p_location text,
  p_required_terms_types text[],
  p_grants jsonb,
  p_recruit_opens_at timestamptz,
  p_sessions jsonb,
  p_actor uuid,
  p_actor_role text,
  p_auto_approve boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offering_id uuid;
  v_first timestamptz;
  v_last timestamptz;
  v_count integer;
begin
  if p_actor is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 개설강의를 생성할 수 있습니다.';
  end if;
  if p_recruit_opens_at is null then
    raise exception '모집 시작 시각이 필요합니다.';
  end if;
  if p_sessions is null or jsonb_typeof(p_sessions) <> 'array' then
    raise exception '회차 목록(배열)이 필요합니다.';
  end if;
  v_count := jsonb_array_length(p_sessions);
  if v_count < 1 then
    raise exception '회차가 1개 이상 필요합니다.';
  end if;
  if v_count > 100 then
    raise exception '회차는 최대 100개까지 만들 수 있습니다.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_sessions) e
    where jsonb_typeof(e) <> 'object'
       or not (e ? 'date' and e ? 'start' and e ? 'end')
       or jsonb_typeof(e -> 'date') <> 'string'
       or jsonb_typeof(e -> 'start') <> 'string'
       or jsonb_typeof(e -> 'end') <> 'string'
  ) then
    raise exception '회차는 {"date","start","end"} 객체여야 합니다.';
  end if;

  select min(((e ->> 'date')::date + (e ->> 'start')::time) at time zone 'Asia/Seoul'),
         max(((e ->> 'date')::date + (e ->> 'end')::time) at time zone 'Asia/Seoul')
    into v_first, v_last
  from jsonb_array_elements(p_sessions) e;

  if p_recruit_opens_at >= v_first then
    raise exception '모집 시작은 개강(첫 회차 시작)보다 앞이어야 합니다.';
  end if;

  insert into public.course_offerings (
    course_id, label, capacity, remaining_seats, price, location,
    recruit_opens_at, opens_at, ends_at, required_terms_types, grants, auto_approve
  ) values (
    p_course_id, p_label, p_capacity, p_capacity, p_price, p_location,
    p_recruit_opens_at, v_first, v_last, p_required_terms_types, p_grants, coalesce(p_auto_approve, false)
  )
  returning id into v_offering_id;

  insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
  select v_offering_id, (e ->> 'date')::date, (e ->> 'start')::time, (e ->> 'end')::time
  from jsonb_array_elements(p_sessions) e;

  -- 원장 기록 (CREATED)
  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    v_offering_id, 'CREATED', 'ADMIN', p_actor, '강의 개설', null,
    jsonb_build_object(
      'label', p_label,
      'capacity', p_capacity,
      'price', p_price,
      'location', p_location,
      'recruit_opens_at', p_recruit_opens_at,
      'required_terms_types', p_required_terms_types,
      'grants', p_grants,
      'auto_approve', coalesce(p_auto_approve, false),
      'sessions', p_sessions
    ),
    clock_timestamp()
  );

  return v_offering_id;
end;
$$;

revoke execute on function public.create_course_offering(
  uuid, text, integer, integer, text, text[], jsonb, timestamptz, jsonb, uuid, text, boolean
) from public, anon, authenticated;
grant execute on function public.create_course_offering(
  uuid, text, integer, integer, text, text[], jsonb, timestamptz, jsonb, uuid, text, boolean
) to service_role;


-- =====================================================================
-- 3. update_course_offering — DEFINER 전환 및 원장 기록
-- =====================================================================
drop function if exists public.update_course_offering(uuid, uuid, text, jsonb);

create function public.update_course_offering(
  p_offering_id uuid,
  p_actor uuid,
  p_actor_role text,
  p_reason text,
  p_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed text[] := array[
    'label', 'location', 'recruit_opens_at', 'required_terms_types',
    'discord_role_id', 'discord_channel_id', 'auto_approve', 'manual_end', 'capacity', 'price'
  ];
  v_key text;
  v_type text;
  v_old public.course_offerings%rowtype;
  v_changes jsonb := '{}'::jsonb;

  v_label text;
  v_location text;
  v_recruit timestamptz;
  v_opens timestamptz;
  v_terms text[];
  v_old_terms text[];
  v_auto boolean;
  v_manual boolean;
  v_cap int;
  v_rem int;
  v_price int;
  v_grants jsonb;

  v_cur_role text;
  v_cur_channel text;
  v_role text;
  v_channel text;
  v_occupied int;
  v_rows int;

  v_k text;
  v_v jsonb;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
begin
  if p_actor is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 개설강의를 수정할 수 있습니다.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '수정 사유를 입력해야 합니다.';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception '수정할 값이 필요합니다.';
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if not (v_key = any (v_allowed)) then
      raise exception '수정할 수 없는 항목입니다: %', v_key;
    end if;
  end loop;
  if p_patch = '{}'::jsonb then
    raise exception '변경된 값이 없습니다.';
  end if;

  select * into v_old from public.course_offerings where id = p_offering_id for update;
  if not found then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_old.deleted_at is not null then
    raise exception '삭제된 개설강의는 수정할 수 없습니다.';
  end if;
  if v_old.status in ('CANCELLING', 'CANCELLED') then
    raise exception '폐강된 개설강의는 수정할 수 없습니다.';
  end if;
  
  if (v_old.status = 'CLOSED' or v_old.opens_at <= now()) then
    if (p_patch ? 'price' or p_patch ? 'capacity' or p_patch ? 'recruit_opens_at') then
      raise exception '개강했거나 마감된 수업의 핵심 정보(가격, 정원, 모집 시작)는 수정할 수 없습니다.';
    end if;
  end if;

  v_label := v_old.label;
  v_location := v_old.location;
  v_recruit := v_old.recruit_opens_at;
  v_opens := v_old.opens_at;
  v_terms := v_old.required_terms_types;
  v_auto := v_old.auto_approve;
  v_manual := v_old.manual_end;
  v_cap := v_old.capacity;
  v_rem := v_old.remaining_seats;
  v_price := v_old.price;
  v_grants := v_old.grants;

  if p_patch ? 'label' then
    v_type := jsonb_typeof(p_patch -> 'label');
    if v_type not in ('string', 'null') then
      raise exception '회차 라벨은 문자열이어야 합니다.';
    end if;
    v_label := nullif(btrim(p_patch ->> 'label'), '');
    if v_label is distinct from v_old.label then
      v_changes := v_changes || jsonb_build_object('label', jsonb_build_object('from', v_old.label, 'to', v_label));
    end if;
  end if;

  if p_patch ? 'location' then
    v_type := jsonb_typeof(p_patch -> 'location');
    if v_type not in ('string', 'null') then
      raise exception '위치는 문자열이어야 합니다.';
    end if;
    v_location := nullif(btrim(p_patch ->> 'location'), '');
    if v_location is distinct from v_old.location then
      v_changes := v_changes || jsonb_build_object('location', jsonb_build_object('from', v_old.location, 'to', v_location));
    end if;
  end if;

  if p_patch ? 'recruit_opens_at' then
    if jsonb_typeof(p_patch -> 'recruit_opens_at') <> 'string' then
      raise exception '모집 시작 시각이 필요합니다.';
    end if;
    v_recruit := (p_patch ->> 'recruit_opens_at')::timestamptz;
    if v_recruit is distinct from v_old.recruit_opens_at then
      v_changes := v_changes || jsonb_build_object('recruit_opens_at', jsonb_build_object('from', v_old.recruit_opens_at, 'to', v_recruit));
    end if;
  end if;

  if v_recruit >= v_opens then
    raise exception '모집 시작은 개강보다 앞이어야 합니다.';
  end if;

  if p_patch ? 'required_terms_types' then
    if jsonb_typeof(p_patch -> 'required_terms_types') <> 'array' then
      raise exception '추가 약관은 배열이어야 합니다.';
    end if;
    v_terms := array(
      select distinct x from jsonb_array_elements_text(p_patch -> 'required_terms_types') as x order by x
    );
    v_old_terms := array(select distinct x from unnest(v_old.required_terms_types) as x order by x);
    if v_terms is distinct from v_old_terms then
      v_changes := v_changes || jsonb_build_object(
        'required_terms_types', jsonb_build_object('from', to_jsonb(v_old_terms), 'to', to_jsonb(v_terms))
      );
    end if;
  end if;

  if p_patch ? 'auto_approve' then
    if jsonb_typeof(p_patch -> 'auto_approve') <> 'boolean' then
      raise exception '자동승인은 true/false여야 합니다.';
    end if;
    v_auto := (p_patch ->> 'auto_approve')::boolean;
    if v_auto is distinct from v_old.auto_approve then
      v_changes := v_changes || jsonb_build_object('auto_approve', jsonb_build_object('from', v_old.auto_approve, 'to', v_auto));
    end if;
  end if;

  if p_patch ? 'manual_end' then
    if jsonb_typeof(p_patch -> 'manual_end') <> 'boolean' then
      raise exception '수동 종료는 true/false여야 합니다.';
    end if;
    v_manual := (p_patch ->> 'manual_end')::boolean;
    if v_manual is distinct from v_old.manual_end then
      v_changes := v_changes || jsonb_build_object('manual_end', jsonb_build_object('from', v_old.manual_end, 'to', v_manual));
    end if;
  end if;

  if p_patch ? 'price' then
    if jsonb_typeof(p_patch -> 'price') <> 'number' or (p_patch ->> 'price')::numeric <> trunc((p_patch ->> 'price')::numeric) then
      raise exception '가격은 정수(원)여야 합니다.';
    end if;
    v_price := (p_patch ->> 'price')::int;
    if v_price < 0 then
      raise exception '가격은 0 이상이어야 합니다.';
    end if;
    if v_price is distinct from v_old.price then
      v_changes := v_changes || jsonb_build_object('price', jsonb_build_object('from', v_old.price, 'to', v_price));
    end if;
  end if;

  if p_patch ? 'capacity' then
    if jsonb_typeof(p_patch -> 'capacity') <> 'number' or (p_patch ->> 'capacity')::numeric <> trunc((p_patch ->> 'capacity')::numeric) then
      raise exception '정원은 정수여야 합니다.';
    end if;
    v_cap := (p_patch ->> 'capacity')::int;
    v_occupied := v_old.capacity - v_old.remaining_seats;
    if v_cap < 0 or v_cap < v_occupied then
      raise exception '정원은 현재 점유 좌석(%명)보다 작을 수 없습니다.', v_occupied;
    end if;
    v_rem := v_old.remaining_seats + (v_cap - v_old.capacity);
    if v_cap is distinct from v_old.capacity then
      v_changes := v_changes || jsonb_build_object('capacity', jsonb_build_object('from', v_old.capacity, 'to', v_cap));
    end if;
  end if;

  if p_patch ? 'discord_role_id' or p_patch ? 'discord_channel_id' then
    select e ->> 'discord_role_id', e ->> 'discord_channel_id'
      into v_cur_role, v_cur_channel
      from jsonb_array_elements(v_old.grants) as e
      where e ->> 'type' = 'DISCORD_ROLE'
      limit 1;

    v_role := v_cur_role;
    v_channel := v_cur_channel;
    if p_patch ? 'discord_role_id' then
      if jsonb_typeof(p_patch -> 'discord_role_id') not in ('string', 'null') then
        raise exception '디스코드 역할 ID는 문자열이어야 합니다.';
      end if;
      v_role := nullif(btrim(p_patch ->> 'discord_role_id'), '');
    end if;
    if p_patch ? 'discord_channel_id' then
      if jsonb_typeof(p_patch -> 'discord_channel_id') not in ('string', 'null') then
        raise exception '디스코드 채널 ID는 문자열이어야 합니다.';
      end if;
      v_channel := nullif(btrim(p_patch ->> 'discord_channel_id'), '');
    end if;
    if v_role is null and v_channel is not null then
      raise exception '디스코드 채널은 역할과 함께만 설정할 수 있습니다.';
    end if;

    select coalesce(jsonb_agg(t.e order by t.ord), '[]'::jsonb)
      into v_grants
      from jsonb_array_elements(v_old.grants) with ordinality as t(e, ord)
      where t.e ->> 'type' <> 'DISCORD_ROLE';
    if v_role is not null then
      v_grants := v_grants || jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'type', 'DISCORD_ROLE', 'discord_role_id', v_role, 'discord_channel_id', v_channel
        ))
      );
    end if;

    if v_role is distinct from v_cur_role then
      v_changes := v_changes || jsonb_build_object('discord_role_id', jsonb_build_object('from', v_cur_role, 'to', v_role));
    end if;
    if v_channel is distinct from v_cur_channel then
      v_changes := v_changes || jsonb_build_object('discord_channel_id', jsonb_build_object('from', v_cur_channel, 'to', v_channel));
    end if;
  end if;

  if v_changes = '{}'::jsonb then
    raise exception '변경된 값이 없습니다.';
  end if;

  update public.course_offerings
  set label = v_label,
      location = v_location,
      recruit_opens_at = v_recruit,
      required_terms_types = v_terms,
      auto_approve = v_auto,
      manual_end = v_manual,
      capacity = v_cap,
      remaining_seats = v_rem,
      price = v_price,
      grants = v_grants
  where id = p_offering_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception '개설강의를 수정할 수 없습니다(권한 또는 상태를 확인하세요).';
  end if;

  -- before / after 추출
  for v_k, v_v in select key, value from jsonb_each(v_changes) loop
    v_before := v_before || jsonb_build_object(v_k, v_v -> 'from');
    v_after := v_after || jsonb_build_object(v_k, v_v -> 'to');
  end loop;

  -- 원장 기록 (UPDATED)
  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    p_offering_id, 'UPDATED', 'ADMIN', p_actor, btrim(p_reason),
    v_before, v_after, clock_timestamp()
  );

  return v_changes;
end;
$$;

revoke execute on function public.update_course_offering(
  uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.update_course_offering(
  uuid, uuid, text, text, jsonb
) to service_role;


-- =====================================================================
-- 4. set_course_offering_status — DEFINER 전환 및 원장 기록
-- =====================================================================
drop function if exists public.set_course_offering_status(uuid, text, text, uuid);

create function public.set_course_offering_status(
  p_offering_id uuid,
  p_next_status text,
  p_reason text,
  p_actor uuid,
  p_actor_role text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
begin
  if p_actor is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 상태를 변경할 수 있습니다.';
  end if;
  if p_next_status not in ('OPEN', 'CLOSED') then
    raise exception '알 수 없는 상태입니다: %', p_next_status;
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '% 사유를 입력해야 합니다.', case when p_next_status = 'CLOSED' then '마감' else '재개' end;
  end if;

  select status into v_current from public.course_offerings where id = p_offering_id for update;
  if v_current is null then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_current in ('CANCELLING', 'CANCELLED') then
    raise exception '폐강 중이거나 폐강 완료된 개설강의는 마감·재개할 수 없습니다.';
  end if;
  if v_current = p_next_status then
    raise exception '이미 % 상태입니다.', case when p_next_status = 'CLOSED' then '마감' else '재개' end;
  end if;

  update public.course_offerings
  set status = p_next_status,
      status_reason = p_reason,
      status_changed_by = p_actor,
      status_changed_at = clock_timestamp()
  where id = p_offering_id;

  -- 원장 기록 (STATUS_CHANGED)
  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    p_offering_id, 'STATUS_CHANGED', 'ADMIN', p_actor, btrim(p_reason),
    jsonb_build_object('status', v_current),
    jsonb_build_object('status', p_next_status),
    clock_timestamp()
  );
end;
$$;

revoke execute on function public.set_course_offering_status(
  uuid, text, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.set_course_offering_status(
  uuid, text, text, uuid, text
) to service_role;


-- =====================================================================
-- 5. delete_course_offering — DEFINER 전환 및 원장 기록
-- =====================================================================
drop function if exists public.delete_course_offering(uuid, text, uuid);

create function public.delete_course_offering(
  p_offering_id uuid,
  p_reason text,
  p_actor uuid,
  p_actor_role text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_count integer;
begin
  if p_actor is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 개설강의를 삭제할 수 있습니다.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '삭제 사유를 입력해야 합니다.';
  end if;

  select count(*) into v_order_count
  from public.orders
  where course_offering_id = p_offering_id;

  if v_order_count > 0 then
    raise exception '삭제 실패(신청 내역이 있으면 삭제할 수 없습니다). 모집 중이면 폐강을 사용하세요.';
  end if;

  update public.course_offerings
  set deleted_at = now(),
      deleted_reason = p_reason,
      deleted_by = p_actor
  where id = p_offering_id;

  update public.course_sessions
  set deactivated_at = now(),
      deactivated_reason = p_reason
  where course_offering_id = p_offering_id
    and deactivated_at is null;

  -- 원장 기록 (DELETED)
  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    p_offering_id, 'DELETED', 'ADMIN', p_actor, btrim(p_reason),
    null,
    jsonb_build_object('deleted_reason', p_reason),
    clock_timestamp()
  );
end;
$$;

revoke execute on function public.delete_course_offering(
  uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.delete_course_offering(
  uuid, text, uuid, text
) to service_role;


-- =====================================================================
-- 6. add_course_session — DEFINER 전환 및 원장 기록
-- =====================================================================
drop function if exists public.add_course_session(uuid, uuid, text, date, time, time);

create function public.add_course_session(
  p_offering_id uuid,
  p_actor uuid,
  p_actor_role text,
  p_reason text,
  p_date date,
  p_start time,
  p_end time
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_actor is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 회차를 추가할 수 있습니다.';
  end if;
  if p_date is null or p_start is null or p_end is null then
    raise exception '날짜와 시작·종료 시각이 필요합니다.';
  end if;
  if p_end <= p_start then
    raise exception '종료 시각은 시작 시각보다 늦어야 합니다.';
  end if;

  perform public.assert_course_sessions_editable(p_offering_id, p_actor, p_reason);

  begin
    insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
    values (p_offering_id, p_date, p_start, p_end)
    returning id into v_id;
  exception when check_violation then
    if sqlerrm like '%course_offerings_recruit_before_opens%' then
      raise exception '모집 시작은 개강(첫 회차 시작)보다 앞이어야 합니다.';
    end if;
    raise;
  end;

  -- 원장 기록 (SESSION_ADDED)
  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    p_offering_id, 'SESSION_ADDED', 'ADMIN', p_actor, btrim(p_reason),
    null,
    jsonb_build_object(
      'session_id', v_id,
      'session_date', p_date,
      'start_time', to_char(p_start, 'HH24:MI'),
      'end_time', to_char(p_end, 'HH24:MI')
    ),
    clock_timestamp()
  );

  return v_id;
end;
$$;

revoke execute on function public.add_course_session(
  uuid, uuid, text, text, date, time, time
) from public, anon, authenticated;
grant execute on function public.add_course_session(
  uuid, uuid, text, text, date, time, time
) to service_role;


-- =====================================================================
-- 7. cancel_course_session — DEFINER 전환 및 원장 기록
-- =====================================================================
drop function if exists public.cancel_course_session(uuid, uuid, text);

create function public.cancel_course_session(
  p_session_id uuid,
  p_actor uuid,
  p_actor_role text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offering_id uuid;
  v_deactivated timestamptz;
  v_date date;
  v_start time;
  v_end time;
begin
  if p_actor is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 회차를 취소할 수 있습니다.';
  end if;

  select course_offering_id, deactivated_at, session_date, start_time, end_time
    into v_offering_id, v_deactivated, v_date, v_start, v_end
  from public.course_sessions where id = p_session_id;
  if not found then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  perform public.assert_course_sessions_editable(v_offering_id, p_actor, p_reason);

  select deactivated_at into v_deactivated from public.course_sessions where id = p_session_id;
  if v_deactivated is not null then
    raise exception '이미 취소된 회차입니다.';
  end if;

  update public.course_sessions
  set deactivated_at = now(),
      deactivated_reason = btrim(p_reason)
  where id = p_session_id;

  -- 원장 기록 (SESSION_CANCELLED)
  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    v_offering_id, 'SESSION_CANCELLED', 'ADMIN', p_actor, btrim(p_reason),
    jsonb_build_object(
      'session_id', p_session_id,
      'session_date', v_date,
      'start_time', to_char(v_start, 'HH24:MI'),
      'end_time', to_char(v_end, 'HH24:MI')
    ),
    jsonb_build_object('deactivated_reason', btrim(p_reason)),
    clock_timestamp()
  );
end;
$$;

revoke execute on function public.cancel_course_session(
  uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.cancel_course_session(
  uuid, uuid, text, text
) to service_role;


-- =====================================================================
-- 8. assert_course_sessions_editable — 권한 축소 (service_role 전용)
-- =====================================================================
revoke execute on function public.assert_course_sessions_editable(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.assert_course_sessions_editable(uuid, uuid, text) to service_role;


-- =====================================================================
-- 9. cancel_course_offering — p_actor_role 추가 및 원장 기록
-- =====================================================================
drop function if exists public.cancel_course_offering(uuid, text, uuid);

create function public.cancel_course_offering(
  p_offering_id uuid,
  p_reason text,
  p_actor uuid,
  p_actor_role text
)
returns table (order_id uuid, user_id uuid, action text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
  v_ended timestamptz;
  v_order record;
  v_action_count integer := 0;
begin
  if p_actor is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 폐강할 수 있습니다.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '폐강 사유를 입력해야 합니다.';
  end if;

  select status, ended_at into v_current, v_ended
  from public.course_offerings
  where id = p_offering_id
  for update;

  if v_current is null then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_ended is not null then
    raise exception '이미 종료된 개설강의는 폐강할 수 없습니다. 종료를 취소한 뒤에 폐강하세요.';
  end if;
  if v_current not in ('OPEN', 'CLOSED') then
    raise exception '모집 중(OPEN)이거나 마감(CLOSED)인 개설강의만 폐강할 수 있습니다.';
  end if;

  update public.course_offerings
  set status = 'CANCELLING',
      status_reason = p_reason,
      status_changed_by = p_actor,
      status_changed_at = clock_timestamp()
  where id = p_offering_id;

  -- 결제 전(UNPAID) 신청서 정리 (종료와 공유하는 헬퍼)
  return query select * from public.settle_unpaid_orders_of_offering(p_offering_id);

  for v_order in (
    select o.id, o.user_id
    from public.orders o
    where o.course_offering_id = p_offering_id
      and o.status = 'APPROVED'
      and o.payment_status in ('PAID', 'PARTIALLY_REFUNDED', 'WAIVED')
  ) loop
    v_action_count := v_action_count + 1;
    order_id := v_order.id;
    user_id := v_order.user_id;
    action := 'ACTION_REQUIRED';
    return next;
  end loop;

  -- 원장 기록 (CANCEL_STARTED)
  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    p_offering_id, 'CANCEL_STARTED', 'ADMIN', p_actor, btrim(p_reason),
    jsonb_build_object('status', v_current),
    jsonb_build_object('status', 'CANCELLING', 'action_required', v_action_count),
    clock_timestamp()
  );
end;
$$;

revoke execute on function public.cancel_course_offering(
  uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.cancel_course_offering(
  uuid, text, uuid, text
) to service_role;


-- =====================================================================
-- 10. complete_course_offering_cancel — p_actor_role 추가 및 원장 기록
-- =====================================================================
drop function if exists public.complete_course_offering_cancel(uuid, uuid);

create function public.complete_course_offering_cancel(
  p_offering_id uuid,
  p_actor uuid,
  p_actor_role text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
  v_remaining integer;
begin
  if p_actor is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 폐강을 마무리할 수 있습니다.';
  end if;

  select status into v_current
  from public.course_offerings
  where id = p_offering_id
  for update;

  if v_current is null then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_current <> 'CANCELLING' then
    raise exception '폐강 중(CANCELLING)인 개설강의만 마무리할 수 있습니다.';
  end if;

  select count(*) into v_remaining
  from public.orders
  where course_offering_id = p_offering_id
    and status in ('PENDING', 'APPROVED');

  if v_remaining > 0 then
    raise exception '남은 %건의 수강생 처리가 끝나지 않아 폐강 마무리를 할 수 없습니다.', v_remaining;
  end if;

  update public.course_offerings
  set status = 'CANCELLED',
      status_changed_by = p_actor,
      status_changed_at = clock_timestamp()
  where id = p_offering_id;

  -- 원장 기록 (CANCEL_COMPLETED)
  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    p_offering_id, 'CANCEL_COMPLETED', 'ADMIN', p_actor, '폐강 완료',
    jsonb_build_object('status', 'CANCELLING'),
    jsonb_build_object('status', 'CANCELLED'),
    clock_timestamp()
  );
end;
$$;

revoke execute on function public.complete_course_offering_cancel(
  uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.complete_course_offering_cancel(
  uuid, uuid, text
) to service_role;


-- =====================================================================
-- 11. end_course_offering — 원장 기록
-- =====================================================================
create or replace function public.end_course_offering(
  p_offering_id uuid,
  p_actor uuid,
  p_actor_role text,
  p_note text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_off record;
  v_order record;
  v_note text;
  v_count integer := 0;
begin
  if p_actor_role is null or p_actor_role not in ('ADMIN', 'SYSTEM') then
    raise exception '알 수 없는 행위자 역할입니다: %', p_actor_role;
  end if;
  if p_actor_role = 'ADMIN' then
    if p_actor is null then
      raise exception '행위자가 필요합니다.';
    end if;
    if p_note is null or btrim(p_note) = '' then
      raise exception '종료 비고를 입력해 주세요.';
    end if;
    v_note := btrim(p_note);
  else
    p_actor := null;
    v_note := coalesce(nullif(btrim(p_note), ''), '기간 만료 자동 종료');
  end if;

  select id, status, opens_at, ends_at, ended_at, deleted_at
    into v_off
  from public.course_offerings
  where id = p_offering_id
  for update;

  if v_off.id is null then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_off.deleted_at is not null then
    raise exception '삭제된 개설강의는 종료할 수 없습니다.';
  end if;
  if v_off.ended_at is not null then
    raise exception '이미 종료된 개설강의입니다.' using errcode = 'restrict_violation';
  end if;
  if v_off.status not in ('OPEN', 'CLOSED') then
    raise exception '폐강 진행·완료된 개설강의는 종료할 수 없습니다.';
  end if;
  if v_off.opens_at > now() then
    raise exception '아직 개강하지 않은 개설강의는 종료할 수 없습니다. 중단하려면 폐강하세요.';
  end if;
  if v_off.ends_at is not null and v_off.ends_at > now() then
    raise exception '종강일이 지나지 않은 개설강의는 종료할 수 없습니다. 기간 중 중단은 폐강을 쓰세요.';
  end if;
  if p_actor_role = 'SYSTEM' and v_off.ends_at is null then
    raise exception '종강일이 없는 개설강의는 자동 종료할 수 없습니다(수동 종료만).';
  end if;

  update public.course_offerings
  set ended_at = now(),
      ended_by = p_actor,
      end_note = v_note
  where id = p_offering_id;

  perform public.settle_unpaid_orders_of_offering(p_offering_id);

  for v_order in (
    select o.id, o.user_id
    from public.orders o
    where o.course_offering_id = p_offering_id
      and o.status = 'APPROVED'
  ) loop
    insert into public.outbox_messages (topic, payload)
    values (
      'ORDER_COURSE_ENDED',
      jsonb_build_object('order_id', v_order.id, 'user_id', v_order.user_id, 'offering_id', p_offering_id)
    );
    v_count := v_count + 1;
  end loop;

  -- 원장 기록 (ENDED)
  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    p_offering_id, 'ENDED', p_actor_role, p_actor, v_note,
    null,
    jsonb_build_object('ended_at', now(), 'end_note', v_note, 'approved_orders', v_count),
    clock_timestamp()
  );

  return v_count;
end;
$$;

revoke execute on function public.end_course_offering(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.end_course_offering(uuid, uuid, text, text) to service_role;


-- =====================================================================
-- 12. reopen_course_offering — p_actor_role 추가 및 원장 기록
-- =====================================================================
drop function if exists public.reopen_course_offering(uuid, uuid, text);

create function public.reopen_course_offering(
  p_offering_id uuid,
  p_actor uuid,
  p_actor_role text,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_off record;
  v_order record;
  v_event_id uuid;
  v_previous jsonb;
  v_count integer := 0;
begin
  if p_actor is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 종료를 취소할 수 있습니다.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '종료 취소 사유를 입력해 주세요.';
  end if;

  select id, status, ended_at, ended_by, end_note, grants, deleted_at
    into v_off
  from public.course_offerings
  where id = p_offering_id
  for update;

  if v_off.id is null then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_off.deleted_at is not null then
    raise exception '삭제된 개설강의의 종료는 취소할 수 없습니다.';
  end if;
  if v_off.ended_at is null then
    raise exception '종료된 개설강의만 종료를 취소할 수 있습니다.' using errcode = 'restrict_violation';
  end if;
  if v_off.status not in ('OPEN', 'CLOSED') then
    raise exception '폐강 진행·완료된 개설강의의 종료는 취소할 수 없습니다.';
  end if;

  v_previous := jsonb_build_object('ended_at', v_off.ended_at, 'ended_by', v_off.ended_by, 'end_note', v_off.end_note);

  update public.course_offerings
  set ended_at = null,
      ended_by = null,
      end_note = null,
      manual_end = true
  where id = p_offering_id;

  for v_order in (
    select o.id, o.user_id
    from public.orders o
    where o.course_offering_id = p_offering_id
      and o.status = 'APPROVED'
    for update of o
  ) loop
    insert into public.order_events (event_type, actor, actor_user_id, order_id, payload)
    values (
      'ACCESS_GRANTED', 'ADMIN', p_actor, v_order.id,
      jsonb_build_object('reason', btrim(p_reason), 'mode', 'END_CANCELLED', 'previous_end', v_previous)
    )
    returning id into v_event_id;

    insert into public.outbox_messages (topic, payload)
    values (
      'ORDER_ACCESS_GRANTED',
      jsonb_build_object(
        'order_id', v_order.id,
        'user_id', v_order.user_id,
        'grant_event_id', v_event_id,
        'grants', coalesce(v_off.grants, '[]'::jsonb)
      )
    );
    v_count := v_count + 1;
  end loop;

  -- 원장 기록 (END_CANCELLED)
  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    p_offering_id, 'END_CANCELLED', 'ADMIN', p_actor, btrim(p_reason),
    v_previous,
    jsonb_build_object('regranted_orders', v_count),
    clock_timestamp()
  );

  return v_count;
end;
$$;

revoke execute on function public.reopen_course_offering(
  uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.reopen_course_offering(
  uuid, uuid, text, text
) to service_role;


-- =====================================================================
-- 13. apply_schedule_change — change_id를 원장 id로 연결 및 원장 기록
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

  -- 원장 기록 (SCHEDULE_CHANGED): 안내에 쓰일 v_change_id를 기본키로 지정
  insert into public.course_offering_events (
    id, course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    v_change_id, p_offering_id, 'SCHEDULE_CHANGED', 'ADMIN', p_actor, v_reason,
    v_before,
    jsonb_build_object(
      'active_sessions', v_after,
      'cancelled_session_ids', to_jsonb(v_cancel),
      'added_session_ids', to_jsonb(v_added_ids),
      'notified_orders', (select count(*) from public.orders where course_offering_id = p_offering_id and status in ('PENDING', 'APPROVED'))
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

revoke execute on function public.apply_schedule_change(
  uuid, uuid, text, text, uuid[], jsonb
) from public, anon, authenticated;
grant execute on function public.apply_schedule_change(
  uuid, uuid, text, text, uuid[], jsonb
) to service_role;
