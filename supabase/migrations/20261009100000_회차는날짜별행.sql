-- 회차 = 날짜별 행. 개강·종료는 입력이 아니라 회차에서 계산한다.
--
--  · course_sessions: 「요일 슬롯 + 기간」(day_of_week, valid_from, valid_until) → 「한 날짜 1행」(session_date + 시각).
--    기존 슬롯 행은 이 파일 안에서 날짜 행으로 펼치고 행 수를 검증한다(다르면 중단).
--    겹침 방지(전역, 비활성 제외)와 학생 시간 충돌은 날짜별 시간대 비교로 바꾼다.
--  · course_offerings.opens_at/ends_at: 컬럼은 남기되 **입력이 아니라 트리거가 관리하는 계산 캐시**(안 A).
--    활성 회차의 첫 시작·마지막 끝(한국 시각)을 course_sessions 트리거가 다시 계산해 쓴다. update_course_offering는 이 키를 더 받지 않는다.
--  · 활성 회차는 1개 이상 — 마지막 활성 회차는 비활성화할 수 없다(삭제된 개설강의는 면제).
--  · create_course_offering: 요일·시각·개강·종료 인자 대신 p_sessions jsonb(날짜별 회차 배열).
--  · course_offerings.is_one_time 삭제(회차 수가 곧 정의. 재수강을 막는 로직은 원래 없었다).
--  새 함수 grant는 같은 파일에 쓴다. 테이블 권한·RLS는 그대로.

-- =====================================================================
-- 1. course_sessions 재정의
-- =====================================================================
alter table public.course_sessions drop constraint course_sessions_no_overlap_active;

alter table public.course_sessions add column session_date date;

do $$
declare
  v_expected integer;
  v_inserted integer;
begin
  select coalesce(sum(
    (select count(*) from generate_series(cs.valid_from, cs.valid_until, interval '1 day') d
      where extract(dow from d)::smallint = cs.day_of_week)
  ), 0)
  into v_expected
  from public.course_sessions cs
  where cs.session_date is null;

  insert into public.course_sessions (
    course_offering_id, day_of_week, start_time, end_time, valid_from, valid_until,
    created_at, deactivated_at, deactivated_reason, session_date
  )
  select cs.course_offering_id, cs.day_of_week, cs.start_time, cs.end_time, cs.valid_from, cs.valid_until,
         cs.created_at, cs.deactivated_at, cs.deactivated_reason, d::date
  from public.course_sessions cs
  cross join lateral generate_series(cs.valid_from, cs.valid_until, interval '1 day') d
  where cs.session_date is null
    and extract(dow from d)::smallint = cs.day_of_week;

  get diagnostics v_inserted = row_count;
  if v_inserted <> v_expected then
    raise exception '회차 변환 행 수가 맞지 않습니다(기대 %, 실제 %) — 마이그레이션을 중단합니다.', v_expected, v_inserted;
  end if;

  delete from public.course_sessions where session_date is null;
end $$;

alter table public.course_sessions alter column session_date set not null;
alter table public.course_sessions drop column day_of_week;
alter table public.course_sessions drop column valid_from;
alter table public.course_sessions drop column valid_until;

-- 같은 시간대(날짜 + 시각)에 활성 회차가 둘 이상일 수 없다. 강사 1인 전제로 개설강의 전체에 걸쳐 전역(예전과 같은 의미).
alter table public.course_sessions add constraint course_sessions_no_overlap_active
  exclude using gist (
    tsrange(session_date + start_time, session_date + end_time) with &&
  ) where (deactivated_at is null);

create index course_sessions_offering_date_idx on public.course_sessions (course_offering_id, session_date);

-- =====================================================================
-- 2. 계산 캐시 트리거 — 개강·종료는 회차에서 계산한다(쓰는 곳은 이 함수 하나)
-- =====================================================================
create function public.sync_offering_schedule_from_sessions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first timestamptz;
  v_last timestamptz;
begin
  select min((session_date + start_time) at time zone 'Asia/Seoul'),
         max((session_date + end_time) at time zone 'Asia/Seoul')
    into v_first, v_last
  from public.course_sessions
  where course_offering_id = new.course_offering_id
    and deactivated_at is null;

  -- 활성 회차가 하나도 없는 경우(삭제된 개설강의)는 마지막 값을 그대로 둔다.
  if v_first is not null then
    update public.course_offerings
    set opens_at = v_first,
        ends_at = v_last
    where id = new.course_offering_id
      and (opens_at is distinct from v_first or ends_at is distinct from v_last);
  end if;
  return null;
end;
$$;

create trigger course_sessions_sync_offering_schedule
  after insert or update of session_date, start_time, end_time, deactivated_at on public.course_sessions
  for each row execute function public.sync_offering_schedule_from_sessions();

-- 마지막 활성 회차는 비활성화할 수 없다(회차가 없는 수업은 없다). 삭제된 개설강의는 면제(delete_course_offering가 먼저 삭제 표시를 한다).
create function public.guard_last_active_session()
returns trigger
language plpgsql
set search_path = public
as $$
begin
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
$$;

create trigger course_sessions_guard_last_active
  before update of deactivated_at on public.course_sessions
  for each row execute function public.guard_last_active_session();

-- =====================================================================
-- 3. 학생 시간 충돌 — 같은 날짜 + 겹치는 시각(둘 다 활성 회차)
-- =====================================================================
create or replace function public.check_no_student_schedule_conflict()
returns trigger
language plpgsql
as $$
begin
  if new.course_offering_id is null then
    return new;
  end if;

  if new.status not in ('PENDING', 'APPROVED') then
    return new;
  end if;

  if exists (
    select 1
    from public.orders o
    join public.course_sessions cs_old
      on cs_old.course_offering_id = o.course_offering_id and cs_old.deactivated_at is null
    join public.course_sessions cs_new
      on cs_new.course_offering_id = new.course_offering_id and cs_new.deactivated_at is null
    where o.user_id = new.user_id
      and o.id <> new.id
      and o.status in ('PENDING', 'APPROVED')
      and cs_old.session_date = cs_new.session_date
      and public.timerange(cs_old.start_time, cs_old.end_time) && public.timerange(cs_new.start_time, cs_new.end_time)
  ) then
    raise exception '겹치는 시간대에 신청/등록된 다른 강의가 있어 신청할 수 없습니다.';
  end if;

  return new;
end;
$$;

-- =====================================================================
-- 4. create_course_offering — p_sessions(날짜별 회차 배열)
-- =====================================================================
drop function public.create_course_offering(
  uuid, text, integer, integer, text, boolean, timestamptz, timestamptz, text[], jsonb, time, time, smallint[], timestamptz, boolean
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
  p_auto_approve boolean default false
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_offering_id uuid;
  v_first timestamptz;
  v_last timestamptz;
  v_count integer;
begin
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

  -- 개강 = 첫 회차 시작, 종료 = 마지막 회차 끝(한국 시각). 이후 변경은 course_sessions 트리거가 맡는다.
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

  -- 시간대가 겹치면(다른 개설강의와도, 이 배열 안에서도) course_sessions_no_overlap_active가 거부하고 전체가 롤백된다.
  insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
  select v_offering_id, (e ->> 'date')::date, (e ->> 'start')::time, (e ->> 'end')::time
  from jsonb_array_elements(p_sessions) e;

  return v_offering_id;
end;
$$;

-- SECURITY INVOKER — 관리자 세션의 RLS(is_admin)가 쓰기를 막는다(update_course_offering과 같은 패턴).
revoke execute on function public.create_course_offering(
  uuid, text, integer, integer, text, text[], jsonb, timestamptz, jsonb, boolean
) from public, anon;
grant execute on function public.create_course_offering(
  uuid, text, integer, integer, text, text[], jsonb, timestamptz, jsonb, boolean
) to authenticated, service_role;

-- =====================================================================
-- 5. update_course_offering — opens_at/ends_at는 더 이상 패치 키가 아니다(회차에서 계산)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.update_course_offering(p_offering_id uuid, p_actor uuid, p_reason text, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
begin
  if p_actor is null then
    raise exception '행위자가 필요합니다.';
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
  
  -- 개강·종료(opens_at/ends_at)는 입력이 아니라 회차(course_sessions)에서 계산되는 값이라 패치 키가 아니다.
  -- 개강(opens_at 지남) 이후나 마감(CLOSED) 상태일 때 핵심 필드 수정 금지. opens_at = 개강일이고
  -- 모집은 recruit_opens_at ~ 개강 전이므로, 모집 기간 중에는 정원·가격을 고칠 수 있다.
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
    -- 유효한 약관 종류인지는 테이블 CHECK(course_offerings_required_terms_types_valid)가 최종 확인한다.
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

  -- 수동 종료 설정(ADR-0022) — 개강 뒤에도 바꿀 수 있다(동결 대상 아님). 켜면 크론이 자동 종료하지 않는다.
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
    -- 잔여석은 정원 변화량만큼 함께 바뀐다(점유 좌석은 그대로). 아래 단일 UPDATE로 한 번에 반영한다.
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
    -- 채널은 DISCORD_ROLE 항목 안에만 저장되므로 역할 없이 채널만 둘 수 없다.
    if v_role is null and v_channel is not null then
      raise exception '디스코드 채널은 역할과 함께만 설정할 수 있습니다.';
    end if;

    -- DISCORD_ROLE 외 항목은 원래 순서대로 보존하고, DISCORD_ROLE은 맨 뒤에 새로 붙인다.
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

  return v_changes;
end;
$function$;

-- =====================================================================
-- 6. delete_course_offering — 삭제 표시를 먼저 하고 회차를 비활성화
-- =====================================================================
CREATE OR REPLACE FUNCTION public.delete_course_offering(p_offering_id uuid, p_reason text, p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_order_count integer;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '삭제 사유를 입력해야 합니다.';
  end if;

  select count(*) into v_order_count
  from public.orders
  where course_offering_id = p_offering_id;

  if v_order_count > 0 then
    raise exception '삭제 실패(신청 내역이 있으면 삭제할 수 없습니다). 모집 중이면 폐강을 사용하세요.';
  end if;

  -- 삭제 표시를 먼저 한다 — 마지막 활성 회차 보호 트리거는 삭제된 개설강의를 면제한다.
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
end;
$function$;

-- =====================================================================
-- 7. is_one_time 삭제
-- =====================================================================
alter table public.course_offerings drop column is_one_time;
