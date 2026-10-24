-- create or replace function update_course_offering 선언: 마이그레이션 재실행 및 배포 시 멱등성을 보장한다.
-- 개설강의 수정 RPC (update_course_offering) 정의:
--
-- update_course_offering(p_offering_id, p_actor, p_reason, p_patch jsonb) returns jsonb
--  · p_patch는 허용 키만 담는 JSON 객체. **없는 키는 불변**, JSON null은 "지움"(null 허용 필드만).
--    (전 인자 고정 시그니처로 하면 자동승인 토글처럼 한 필드만 바꿀 때 나머지를 오래된 값으로 덮어쓰는
--    경쟁 상태가 생긴다 — 설계 검토 결함 5.)
--  · 허용 키: label, location, opens_at, ends_at, required_terms_types, discord_role_id,
--    discord_channel_id, auto_approve, capacity, price. status·grants·remaining_seats 등은 거부
--    (상태는 set_course_offering_status/cancel_*가 전담 — enforce_status_transition_reason 트리거와 충돌).
--  · 정원(capacity)은 이 함수 한 곳에서만 바뀐다(증가·감소 허용). 행을 FOR UPDATE로
--    잠근 뒤 단일 UPDATE로 capacity와 remaining_seats를 같은 양만큼 함께 바꾼다 — 좌석 예약·반환 함수의
--    원자 UPDATE와 같은 행 잠금으로 직렬화된다. 감소는 새 정원 >= 점유 좌석(= 옛 정원 - 옛 잔여)일 때만.
--  · 가격은 신청이 있어도 바꿀 수 있다(orders.list_price/final_amount가 생성 시점 스냅샷이라 기존 주문 불변).
--  · 디스코드 역할·채널은 grants의 DISCORD_ROLE 항목만 교체·삽입·삭제하고 다른 항목(COURSE_ACCESS,
--    SOURCE_DOWNLOAD)은 보존한다. 주문 상태와 무관(역할 편집 정책은 사용자가 나중에 재검토).
--  · SECURITY INVOKER — 세션 클라이언트의 RLS(is_admin)가 쓰기를 막는다(set_course_offering_status와 같은 패턴).
--  · 반환: 실제로 바뀐 필드의 { "필드": { "from": …, "to": … } }. 서버 액션이 감사 로그·결과 팝업에 쓴다.

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
    'label', 'location', 'opens_at', 'ends_at', 'required_terms_types',
    'discord_role_id', 'discord_channel_id', 'auto_approve', 'capacity', 'price'
  ];
  v_key text;
  v_type text;
  v_old public.course_offerings%rowtype;
  v_changes jsonb := '{}'::jsonb;

  v_label text;
  v_location text;
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
  
  -- [안티패턴 해결] 개강(opens_at 지남) 이후나 마감(CLOSED) 상태일 때 핵심 필드 수정 금지 (Freeze)
  if (v_old.status = 'CLOSED' or v_old.opens_at <= now()) then
    if (p_patch ? 'price' or p_patch ? 'capacity' or p_patch ? 'opens_at' or p_patch ? 'ends_at') then
      raise exception '개강했거나 마감된 수업의 핵심 정보(가격, 정원, 기간)는 수정할 수 없습니다.';
    end if;
  end if;

  v_label := v_old.label;
  v_location := v_old.location;
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

  if p_patch ? 'opens_at' then
    if jsonb_typeof(p_patch -> 'opens_at') <> 'string' then
      raise exception '모집 시작 시각이 필요합니다.';
    end if;
    v_opens := (p_patch ->> 'opens_at')::timestamptz;
    if v_opens is distinct from v_old.opens_at then
      v_changes := v_changes || jsonb_build_object('opens_at', jsonb_build_object('from', v_old.opens_at, 'to', v_opens));
    end if;
  end if;

  if p_patch ? 'ends_at' then
    v_type := jsonb_typeof(p_patch -> 'ends_at');
    if v_type not in ('string', 'null') then
      raise exception '모집 종료 시각은 문자열 또는 null이어야 합니다.';
    end if;
    v_ends := case when v_type = 'null' then null else (p_patch ->> 'ends_at')::timestamptz end;
    if v_ends is distinct from v_old.ends_at then
      v_changes := v_changes || jsonb_build_object('ends_at', jsonb_build_object('from', v_old.ends_at, 'to', v_ends));
    end if;
  end if;
  if v_ends is not null and v_opens >= v_ends then
    raise exception '모집 시작은 종료보다 앞이어야 합니다.';
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
