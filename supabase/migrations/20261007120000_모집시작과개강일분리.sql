-- V-1 — 모집 시작과 개강일 분리.
-- opens_at = 개강일(첫 수업 시작)로 뜻을 고정하고, 모집 시작 recruit_opens_at을 새로 둔다.
-- 신청 가능 기간 = recruit_opens_at ≤ 지금 < opens_at(개강하면 신청 마감, 중간 합류 없음).
-- 수정 잠금(개강 또는 CLOSED → 가격·정원·기간 수정 금지)은 그대로 — 이제 모집 기간 중엔 정원 증감이 된다(TEST84).
-- 수업 기간 미러(course_sessions.valid_from = opens_at 날짜)와 결제 단계 규칙(offering-open: ends_at까지)은 바꾸지 않는다.

-- =====================================================================
-- 1. course_offerings.recruit_opens_at
-- =====================================================================
alter table public.course_offerings add column recruit_opens_at timestamptz;
-- 기존 행: 등록 시각을 모집 시작으로(운영 DB 미존재 — 로컬·테스트 데이터만). 등록이 개강보다 늦은 행은 개강 1분 전으로.
update public.course_offerings
set recruit_opens_at = least(created_at, opens_at - interval '1 minute');
alter table public.course_offerings alter column recruit_opens_at set not null;
alter table public.course_offerings
  add constraint course_offerings_recruit_before_opens check (recruit_opens_at < opens_at);

comment on column public.course_offerings.recruit_opens_at is '모집 시작. 신청 가능 기간 = recruit_opens_at ≤ now < opens_at';
comment on column public.course_offerings.opens_at is '개강일(첫 수업 시작). course_sessions.valid_from이 이 날짜를 미러링한다';
comment on column public.course_offerings.ends_at is '강좌 종료';

-- =====================================================================
-- 2. create_order — 신청 기간 조건만 바꾼다(나머지는 20261007100000 정상판 그대로)
-- =====================================================================
create or replace function public.create_order(
  p_user_id uuid,
  p_course_offering_id uuid,
  p_product_id uuid,
  p_terms_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offering record;
  v_product record;
  v_reserved boolean;
  v_price integer;
  v_order_id uuid;
  v_terms_id uuid;
begin
  if (p_course_offering_id is null) = (p_product_id is null) then
    raise exception '강의 또는 상품 중 정확히 하나를 선택해야 합니다.';
  end if;

  if p_course_offering_id is not null then
    select id, price into v_offering
    from public.course_offerings
    where id = p_course_offering_id
      and status = 'OPEN'
      and deleted_at is null
      and now() >= recruit_opens_at
      and now() < opens_at
    for share;

    if v_offering.id is null then
      raise exception '신청할 수 없는 개설강의입니다.';
    end if;
    v_price := v_offering.price;

    select public.reserve_course_offering_seat(p_course_offering_id) into v_reserved;
    if not coalesce(v_reserved, false) then
      raise exception '정원이 마감되어 신청할 수 없습니다.';
    end if;
  else
    select id, price into v_product
    from public.products
    where id = p_product_id
      and status = 'OPEN'
      and deleted_at is null;

    if v_product.id is null then
      raise exception '구매할 수 없는 상품입니다.';
    end if;
    v_price := v_product.price;
  end if;

  begin
    insert into public.orders (user_id, course_offering_id, product_id, list_price, final_amount)
    values (p_user_id, p_course_offering_id, p_product_id, v_price, v_price)
    returning id into v_order_id;
  exception when unique_violation then
    if p_course_offering_id is not null then
      perform public.release_course_offering_seat(p_course_offering_id);
    end if;
    raise exception '이미 신청(구매)한 내역입니다.';
  end;

  insert into public.order_events (event_type, actor, payload, order_id)
  values ('APPLIED', 'SYSTEM', '{}'::jsonb, v_order_id);

  if p_terms_ids is not null then
    foreach v_terms_id in array p_terms_ids loop
      insert into public.terms_agreements (user_id, terms_id, order_id)
      values (p_user_id, v_terms_id, v_order_id);
    end loop;
  end if;

  -- 자동승인: 개설강의 플래그가 켜져 있으면 같은 트랜잭션에서 APPROVED.
  -- 물품 주문(course_offering_id null)은 스킵. actor는 SYSTEM(사람 관리자 아님).
  -- transition_order APPROVED 분기와 동일: status·approved_at + order_events APPROVED.
  if p_course_offering_id is not null and exists (
    select 1 from public.course_offerings o
    where o.id = p_course_offering_id and o.auto_approve is true
  ) then
    update public.orders
    set status = 'APPROVED',
        approved_at = now()
    where id = v_order_id
      and status = 'PENDING';

    if not found then
      raise exception '자동승인 실패: 주문이 PENDING이 아닙니다.';
    end if;

    insert into public.order_events (event_type, actor, order_id)
    values ('APPROVED', 'SYSTEM', v_order_id);
  end if;

  return v_order_id;
end;
$$;

revoke execute on function public.create_order(uuid, uuid, uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.create_order(uuid, uuid, uuid, uuid[])
  to service_role;

-- =====================================================================
-- 3. create_course_offering — p_recruit_opens_at 추가(필수)
-- =====================================================================
drop function if exists public.create_course_offering(
  uuid, text, integer, integer, text, boolean, timestamptz, timestamptz, text[], jsonb, time, time, smallint[], boolean
);

create function public.create_course_offering(
  p_course_id uuid,
  p_label text,
  p_capacity integer,
  p_price integer,
  p_location text,
  p_is_one_time boolean,
  p_opens_at timestamptz,
  p_ends_at timestamptz,
  p_required_terms_types text[],
  p_grants jsonb,
  p_session_start_time time,
  p_session_end_time time,
  p_days_of_week smallint[],
  p_recruit_opens_at timestamptz,
  p_auto_approve boolean default false
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_offering_id uuid;
  v_valid_from date;
  v_valid_until date;
  v_days smallint[];
begin
  if p_recruit_opens_at is null then
    raise exception '모집 시작 시각이 필요합니다.';
  end if;
  if p_opens_at is null then
    raise exception '개강 시각이 필요합니다.';
  end if;
  if p_recruit_opens_at >= p_opens_at then
    raise exception '모집 시작은 개강보다 앞이어야 합니다.';
  end if;

  insert into public.course_offerings (
    course_id, label, capacity, remaining_seats, price, location, is_one_time,
    recruit_opens_at, opens_at, ends_at, required_terms_types, grants, auto_approve
  ) values (
    p_course_id, p_label, p_capacity, p_capacity, p_price, p_location, p_is_one_time,
    p_recruit_opens_at, p_opens_at, p_ends_at, p_required_terms_types, p_grants, coalesce(p_auto_approve, false)
  )
  returning id into v_offering_id;

  if p_session_start_time is not null and p_session_end_time is not null then
    v_valid_from := p_opens_at::date;
    v_valid_until := coalesce(p_ends_at::date, p_opens_at::date);
    v_days := case
      when p_is_one_time then array[extract(dow from p_opens_at)::smallint]
      else p_days_of_week
    end;

    if v_days is not null and array_length(v_days, 1) > 0 then
      insert into public.course_sessions (
        course_offering_id, day_of_week, start_time, end_time, valid_from, valid_until
      )
      select v_offering_id, d, p_session_start_time, p_session_end_time, v_valid_from, v_valid_until
      from unnest(v_days) as d;
    end if;
  end if;

  return v_offering_id;
end;
$$;

-- SECURITY INVOKER — 관리자 세션의 RLS(is_admin)가 쓰기를 막는다(update_course_offering과 같은 패턴).
revoke execute on function public.create_course_offering(
  uuid, text, integer, integer, text, boolean, timestamptz, timestamptz, text[], jsonb, time, time, smallint[], timestamptz, boolean
) from public, anon;
grant execute on function public.create_course_offering(
  uuid, text, integer, integer, text, boolean, timestamptz, timestamptz, text[], jsonb, time, time, smallint[], timestamptz, boolean
) to authenticated, service_role;

-- =====================================================================
-- 4. update_course_offering — recruit_opens_at 허용 키·잠금·순서 검증, 문구(개강·강좌 종료) 정정
-- =====================================================================
create or replace function public.update_course_offering(
  p_offering_id uuid,
  p_actor uuid,
  p_reason text,
  p_patch jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_allowed text[] := array[
    'label', 'location', 'recruit_opens_at', 'opens_at', 'ends_at', 'required_terms_types',
    'discord_role_id', 'discord_channel_id', 'auto_approve', 'capacity', 'price'
  ];
  v_key text;
  v_type text;
  v_old public.course_offerings%rowtype;
  v_changes jsonb := '{}'::jsonb;

  v_label text;
  v_location text;
  v_recruit timestamptz;
  v_opens timestamptz;
  v_ends timestamptz;
  v_terms text[];
  v_old_terms text[];
  v_auto boolean;
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
  
  -- 개강(opens_at 지남) 이후나 마감(CLOSED) 상태일 때 핵심 필드 수정 금지. opens_at = 개강일이고
  -- 모집은 recruit_opens_at ~ 개강 전이므로, 모집 기간 중에는 정원·가격을 고칠 수 있다.
  if (v_old.status = 'CLOSED' or v_old.opens_at <= now()) then
    if (p_patch ? 'price' or p_patch ? 'capacity' or p_patch ? 'recruit_opens_at' or p_patch ? 'opens_at' or p_patch ? 'ends_at') then
      raise exception '개강했거나 마감된 수업의 핵심 정보(가격, 정원, 기간)는 수정할 수 없습니다.';
    end if;
  end if;

  v_label := v_old.label;
  v_location := v_old.location;
  v_recruit := v_old.recruit_opens_at;
  v_opens := v_old.opens_at;
  v_ends := v_old.ends_at;
  v_terms := v_old.required_terms_types;
  v_auto := v_old.auto_approve;
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

  if p_patch ? 'opens_at' then
    if jsonb_typeof(p_patch -> 'opens_at') <> 'string' then
      raise exception '개강 시각이 필요합니다.';
    end if;
    v_opens := (p_patch ->> 'opens_at')::timestamptz;
    if v_opens is distinct from v_old.opens_at then
      v_changes := v_changes || jsonb_build_object('opens_at', jsonb_build_object('from', v_old.opens_at, 'to', v_opens));
    end if;
  end if;

  if p_patch ? 'ends_at' then
    v_type := jsonb_typeof(p_patch -> 'ends_at');
    if v_type not in ('string', 'null') then
      raise exception '강좌 종료 시각은 문자열 또는 null이어야 합니다.';
    end if;
    v_ends := case when v_type = 'null' then null else (p_patch ->> 'ends_at')::timestamptz end;
    if v_ends is distinct from v_old.ends_at then
      v_changes := v_changes || jsonb_build_object('ends_at', jsonb_build_object('from', v_old.ends_at, 'to', v_ends));
    end if;
  end if;
  if v_ends is not null and v_opens >= v_ends then
    raise exception '개강은 강좌 종료보다 앞이어야 합니다.';
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
      opens_at = v_opens,
      ends_at = v_ends,
      required_terms_types = v_terms,
      auto_approve = v_auto,
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
$$;

revoke execute on function public.update_course_offering(uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.update_course_offering(uuid, uuid, text, jsonb) to authenticated, service_role;
