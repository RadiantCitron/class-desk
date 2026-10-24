-- 강의 종료 = 그 강의의 혜택·권한 전부 회수, 그리고 종료 취소.
--
--  · 종료는 저장 상태를 늘리지 않고 기록으로 남긴다: course_offerings.ended_at / ended_by(null = 자동) / end_note(비고) + manual_end.
--    「강의 중」「종료 처리 대기」「종료」 표시는 날짜와 이 기록에서 계산한다. status 4종(OPEN/CLOSED/CANCELLING/CANCELLED)은 그대로.
--  · end_course_offering(): 종강일이 지난(또는 종강일 없고 개강한) 개설강의를 종료 — 결제 전 신청 정리(폐강과 같은 헬퍼 공유) +
--    승인된 주문마다 사실 ORDER_COURSE_ENDED → 이용권 모듈이 COURSE_ENDED로 회수(환불과 무관, 주문 상태 불변).
--  · reopen_course_offering(): 종료 취소 — 종료 기록을 비우고 manual_end를 켜며(크론이 다시 종료하지 않게) 승인된 주문마다
--    E-2의 ACCESS_GRANTED 이벤트 + ORDER_ACCESS_GRANTED 사실로 이용권을 새 행으로 재부여한다(옛 회수 행은 이력).
--  · 폐강의 결제 전 정리 루프를 헬퍼 settle_unpaid_orders_of_offering()로 빼 폐강·종료가 공유한다. 종료된 강의는 폐강할 수 없다.

-- 1. 종료 기록 칼럼
alter table public.course_offerings
  add column ended_at timestamptz,
  add column ended_by uuid references public.users (id) on delete restrict,
  add column end_note text,
  add column manual_end boolean not null default false;

alter table public.course_offerings
  add constraint course_offerings_end_triple
    check ((ended_at is null) = (end_note is null) and (ended_by is null or ended_at is not null));

-- 2. 아웃박스 사실 토픽
alter table public.outbox_messages drop constraint outbox_messages_topic_check;
alter table public.outbox_messages
  add constraint outbox_messages_topic_check
    check (
      topic in (
        'PAYMENT_SUCCEEDED', 'PAYMENT_REFUNDED', 'ORDER_PAID', 'ORDER_REFUNDED', 'USER_WITHDRAWN',
        'ORDER_OFFERING_CANCELLED', 'ORDER_ACCESS_GRANTED', 'ORDER_CLOSED', 'ORDER_COURSE_ENDED'
      )
      or (topic in ('GRANT_ENTITLEMENTS', 'REVOKE_ENTITLEMENTS', 'SEND_EMAIL', 'DISCORD_LINKED') and processed_at is not null)
    );

-- 3. 결제 전(UNPAID) 신청서 정리 헬퍼 — 폐강·종료가 같이 쓴다(20261008130000의 cancel_course_offering 루프를 그대로 옮김).
create function public.settle_unpaid_orders_of_offering(p_offering_id uuid)
returns table (order_id uuid, user_id uuid, action text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
begin
  for v_order in (
    select o.id, o.user_id, o.status, o.payment_status, o.course_offering_id
    from public.orders o
    where o.course_offering_id = p_offering_id
      and o.payment_status = 'UNPAID'
    for update of o
  ) loop
    if v_order.status = 'PENDING' then
      update public.orders
      set status = 'REJECTED'
      where id = v_order.id;

      insert into public.order_events (event_type, actor, order_id)
      values ('REJECTED', 'SYSTEM', v_order.id);

      if v_order.course_offering_id is not null then
        perform public.release_course_offering_seat(v_order.course_offering_id);
      end if;

      order_id := v_order.id;
      user_id := v_order.user_id;
      action := 'REJECTED';
      return next;
    elsif v_order.status = 'APPROVED' then
      update public.orders
      set status = 'CANCELLED',
          cancelled_at = now()
      where id = v_order.id;

      insert into public.order_events (event_type, actor, order_id)
      values ('CANCELLED', 'SYSTEM', v_order.id);

      if v_order.course_offering_id is not null then
        perform public.release_course_offering_seat(v_order.course_offering_id);
      end if;

      order_id := v_order.id;
      user_id := v_order.user_id;
      action := 'CANCELLED';
      return next;
    end if;
  end loop;
end;
$$;

revoke execute on function public.settle_unpaid_orders_of_offering(uuid) from public, anon, authenticated;
grant execute on function public.settle_unpaid_orders_of_offering(uuid) to service_role;

-- 4. 폐강 시작 교체 — 헬퍼 호출 + 종료된 강의는 폐강 불가. 나머지는 20261008130000과 같다.
create or replace function public.cancel_course_offering(p_offering_id uuid, p_reason text, p_actor uuid)
returns table (order_id uuid, user_id uuid, action text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
  v_ended timestamptz;
  v_order record;
begin
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

  -- 결제 완료·부분 환불·결제 면제 수강생은 자동으로 건드리지 않는다 — 관리자가 학생별로 처리한다(ADR-0021).
  for v_order in (
    select o.id, o.user_id
    from public.orders o
    where o.course_offering_id = p_offering_id
      and o.status = 'APPROVED'
      and o.payment_status in ('PAID', 'PARTIALLY_REFUNDED', 'WAIVED')
  ) loop
    order_id := v_order.id;
    user_id := v_order.user_id;
    action := 'ACTION_REQUIRED';
    return next;
  end loop;
end;
$$;

-- 5. 강의 종료 — 자동(SYSTEM, 크론)과 수동(ADMIN) 공용. 반환 = 이용권 회수 사실을 적재한 승인된 주문 수.
create function public.end_course_offering(
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

  -- 결제 전 신청 정리(좌석 반환 포함) — 폐강과 같은 헬퍼
  perform public.settle_unpaid_orders_of_offering(p_offering_id);

  -- 남은 승인된 주문(결제 완료·부분 환불·결제 면제)마다 회수 사실. 주문 상태는 그대로 둔다(수강 완료 기록).
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

  return v_count;
end;
$$;

revoke execute on function public.end_course_offering(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.end_course_offering(uuid, uuid, text, text) to service_role;

-- 6. 종료 취소 — ADMIN 전용. 종료 기록을 비우고 manual_end를 켜며, 승인된 주문마다 이용권을 새 행으로 재부여한다
--    (E-2의 ACCESS_GRANTED 이벤트 + ORDER_ACCESS_GRANTED 사실 재사용 → E-1 입구 ADMIN_GRANT). 옛 회수 행은 이력으로 남는다.
--    종료 때 정리된 결제 전 신청과 종료 뒤 환불·탈퇴로 취소된 주문은 되살리지 않는다. 원래 종료 일시·비고는 각 주문 이벤트 payload에 남긴다.
create function public.reopen_course_offering(
  p_offering_id uuid,
  p_actor uuid,
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
  if p_actor is null then
    raise exception '행위자가 필요합니다.';
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

  return v_count;
end;
$$;

revoke execute on function public.reopen_course_offering(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reopen_course_offering(uuid, uuid, text) to service_role;

-- 7. update_course_offering 교체 — 현재 정본 본문에 manual_end 키만 추가(허용 키 목록·boolean 검증·변경 기록·UPDATE 한 칸).
--    시그니처·SECURITY INVOKER·권한은 그대로다.
CREATE OR REPLACE FUNCTION public.update_course_offering(p_offering_id uuid, p_actor uuid, p_reason text, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_allowed text[] := array[
    'label', 'location', 'recruit_opens_at', 'opens_at', 'ends_at', 'required_terms_types',
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
  v_ends timestamptz;
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
      opens_at = v_opens,
      ends_at = v_ends,
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
