-- F-8: 판매 창구 하나 · 이중 결제 확정 차단 · 재신청 허용 · 사유 필수 · 단계별 상태 일관성
--
-- 변경 내역:
--   1. orders 유니크 제약 교체:
--      - 기존 orders_user_id_course_offering_id_key UNIQUE (user_id, course_offering_id) 제거
--      - 살아있는 신청(PENDING, APPROVED)에 대해서만 유니크한 부분 유니크 인덱스 생성
--        orders_one_live_per_user_offering (user_id, course_offering_id) WHERE status IN ('PENDING', 'APPROVED') AND course_offering_id IS NOT NULL
--   2. transition_order:
--      - p_reason text default null 추가 (기존 5인자 drop 후 6인자 신설)
--      - next_status IN ('REJECTED', 'CANCELLED') 일 때 p_reason 필수 검증
--      - order_events 에 { reason: p_reason } payload 기록
--   3. update_course_offering (F-9판 기반):
--      - 동결 가드 완화: (status = 'CLOSED' or opens_at <= now()) -> opens_at <= now() (개강 전 마감 상태는 수정 가능)
--      - ended_at IS NOT NULL (종료된 수업)일 때 label, location 외 수정 거부 ('종료된 수업은 별칭(label)과 장소(location) 외에는 수정할 수 없습니다.')
--   4. set_course_offering_status (F-2판 기반):
--      - ended_at IS NOT NULL 일 때 상태 변경 거부 ('종료된 수업입니다. 종료를 취소한 뒤에 상태를 변경하세요.')
--   5. cancel_course_offering (F-2판 기반):
--      - ends_at IS NOT NULL AND ends_at <= now() 일 때 폐강 거부 ('모든 회차가 끝난 수업은 폐강이 아니라 종료합니다. 종료한 뒤 필요한 학생만 개별 환불하세요.')

-- =====================================================================
-- 1. orders 유니크 제약 교체 (재신청 허용)
-- =====================================================================
alter table public.orders
  drop constraint if exists orders_user_id_course_offering_id_key;

drop index if exists public.orders_one_live_per_user_offering;

create unique index orders_one_live_per_user_offering
  on public.orders (user_id, course_offering_id)
  where status in ('PENDING', 'APPROVED') and course_offering_id is not null;

-- 학생 일정 충돌 방지 트리거(check_no_student_schedule_conflict):
-- 같은 강의는 유니크 인덱스(orders_one_live_per_user_offering)가 '이미 신청한 내역입니다'로 처리하므로,
-- 일정 충돌 검사는 '다른' 개설강의(o.course_offering_id <> new.course_offering_id)와의 겹침만 본다.
create or replace function public.check_no_student_schedule_conflict()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.course_offering_id is null then
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
      and o.course_offering_id <> new.course_offering_id
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
-- 2. transition_order 사유 인자 추가 및 검증·원장 기록
-- =====================================================================
drop function if exists public.transition_order(uuid, uuid, text, text, text);
drop function if exists public.transition_order(uuid, uuid, text, text, text, text);

create or replace function public.transition_order(
  p_order_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_event_type text,
  p_next_status text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed_from text[];
  v_order record;
  v_payload jsonb := '{}'::jsonb;
begin
  v_allowed_from := case p_next_status
    when 'APPROVED'  then array['PENDING']
    when 'REJECTED'  then array['PENDING']
    when 'CANCELLED' then array['PENDING', 'APPROVED']
    else null
  end;

  if v_allowed_from is null then
    raise exception '허용되지 않은 전이 대상 상태입니다: %', p_next_status;
  end if;

  if p_actor_role not in ('ADMIN', 'MANAGER') then
    raise exception '알 수 없는 행위자 역할입니다: %', p_actor_role;
  end if;

  if p_next_status in ('REJECTED', 'CANCELLED') then
    if p_reason is null or btrim(p_reason) = '' then
      raise exception '% 사유를 입력해야 합니다.', case when p_next_status = 'REJECTED' then '거절' else '취소' end;
    end if;
  end if;

  select id, user_id, course_offering_id, status, payment_status
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if v_order.id is null then
    raise exception '신청 내역을 찾을 수 없습니다.';
  end if;

  if not (v_order.status = any (v_allowed_from)) then
    raise exception '이미 처리된 신청입니다(현재 상태: %). 화면을 새로고침한 뒤 다시 확인해 주세요.',
      v_order.status
      using errcode = 'restrict_violation';
  end if;

  if p_next_status = 'CANCELLED' and v_order.payment_status <> 'UNPAID' then
    raise exception '이미 결제된 건은 취소가 아니라 환불로 처리해야 합니다.';
  end if;

  update public.orders
  set status = p_next_status,
      approved_at = case when p_next_status = 'APPROVED' then now() else approved_at end,
      cancelled_at = case when p_next_status = 'CANCELLED' then now() else cancelled_at end
  where id = p_order_id
    and status = any (v_allowed_from);

  if not found then
    raise exception '이미 처리된 신청입니다. 화면을 새로고침한 뒤 다시 확인해 주세요.'
      using errcode = 'restrict_violation';
  end if;

  if p_reason is not null and btrim(p_reason) <> '' then
    v_payload := jsonb_build_object('reason', btrim(p_reason));
  end if;

  insert into public.order_events (event_type, actor, actor_user_id, order_id, payload)
  values (
    p_event_type,
    case when p_actor_role = 'ADMIN' then 'ADMIN' else 'MANAGER' end,
    p_actor_id,
    p_order_id,
    v_payload
  );

  if p_next_status in ('REJECTED', 'CANCELLED') and v_order.course_offering_id is not null then
    perform public.release_course_offering_seat(v_order.course_offering_id);
  end if;
end;
$$;

revoke execute on function public.transition_order(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.transition_order(uuid, uuid, text, text, text, text)
  to service_role;

-- =====================================================================
-- 3. update_course_offering (F-9판 기반: 개강 전 마감 수정 허용 + 종료 뒤 별칭/장소 외 거부)
-- =====================================================================
drop function if exists public.update_course_offering(uuid, uuid, text, text, jsonb, boolean);
drop function if exists public.update_course_offering(uuid, uuid, text, text, jsonb);

create or replace function public.update_course_offering(
  p_offering_id uuid,
  p_actor uuid,
  p_actor_role text,
  p_reason text,
  p_patch jsonb,
  p_reissue_discord boolean default false
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

  v_has_live_orders boolean := false;
  v_has_future_sessions boolean := false;
  v_event_id uuid := gen_random_uuid();
  v_reissue_order record;
  v_reissue_count int := 0;
  v_order_event_id uuid;
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

  -- F-8 2-7: 종료 뒤 명령 거부 (별칭·장소만 허용)
  if v_old.ended_at is not null then
    for v_key in select jsonb_object_keys(p_patch) loop
      if v_key not in ('label', 'location') then
        raise exception '종료된 수업은 별칭(label)과 장소(location) 외에는 수정할 수 없습니다.';
      end if;
    end loop;
  end if;
  
  -- F-8 2-5: 동결은 개강 뒤만 (개강 전 마감 상태는 가격/정원/모집시작 수정 허용)
  if v_old.opens_at <= now() then
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
      -- 장소 변경 가드 (F-9 2-1):
      -- 종료 전이고, 시작 전 활성 회차가 1개 이상 있으며, 살아 있는 신청(PENDING, APPROVED)이 있으면 일반 수정 차단
      if v_old.ended_at is null then
        select exists (
          select 1 from public.orders
          where course_offering_id = p_offering_id and status in ('PENDING', 'APPROVED')
        ) into v_has_live_orders;

        select exists (
          select 1 from public.course_sessions
          where course_offering_id = p_offering_id
            and deactivated_at is null
            and not public.session_has_started(session_date, start_time)
        ) into v_has_future_sessions;

        if v_has_live_orders and v_has_future_sessions then
          raise exception '신청자가 있는 수업의 장소는 「수업 조건 변경」으로 바꿉니다(수강생 안내·동의).';
        end if;
      end if;

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

  for v_k, v_v in select key, value from jsonb_each(v_changes) loop
    v_before := v_before || jsonb_build_object(v_k, v_v -> 'from');
    v_after := v_after || jsonb_build_object(v_k, v_v -> 'to');
  end loop;

  -- 디스코드 역할 변경 및 재부여 선택 시 수강생 처리
  if (v_changes ? 'discord_role_id') and coalesce(p_reissue_discord, false) then
    if v_old.ended_at is null and v_old.status not in ('CANCELLING', 'CANCELLED') then
      for v_reissue_order in
        select o.id, o.user_id, o.payment_status
        from public.orders o
        where o.course_offering_id = p_offering_id
          and o.status = 'APPROVED'
          and o.payment_status in ('PAID', 'WAIVED')
        order by o.created_at, o.id
      loop
        v_reissue_count := v_reissue_count + 1;
        insert into public.order_events (event_type, actor, actor_user_id, order_id, payload, created_at)
        values (
          'GRANTS_REISSUED', 'ADMIN', p_actor, v_reissue_order.id,
          jsonb_build_object(
            'reason', p_reason,
            'from_role', v_cur_role,
            'to_role', v_role,
            'offering_event_id', v_event_id
          ),
          clock_timestamp()
        )
        returning id into v_order_event_id;

        insert into public.outbox_messages (topic, payload)
        values (
          'ORDER_GRANTS_REISSUED',
          jsonb_build_object(
            'order_id', v_reissue_order.id,
            'user_id', v_reissue_order.user_id,
            'event_id', v_order_event_id,
            'payment_status', v_reissue_order.payment_status,
            'from_role', v_cur_role,
            'to_role', v_role,
            'reason', p_reason
          )
        );
      end loop;
    end if;
  end if;

  if coalesce(p_reissue_discord, false) then
    v_after := v_after || jsonb_build_object('reissue_existing', true, 'reissued_orders_count', v_reissue_count);
  end if;

  insert into public.course_offering_events (
    id, course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    v_event_id, p_offering_id, 'UPDATED', 'ADMIN', p_actor, btrim(p_reason), v_before, v_after, clock_timestamp()
  );

  return v_changes;
end;
$$;

revoke execute on function public.update_course_offering(
  uuid, uuid, text, text, jsonb, boolean
) from public, anon, authenticated;
grant execute on function public.update_course_offering(
  uuid, uuid, text, text, jsonb, boolean
) to service_role;

-- =====================================================================
-- 4. set_course_offering_status (F-2판 기반: 종료 뒤 상태 변경 거부)
-- =====================================================================
drop function if exists public.set_course_offering_status(uuid, text, text, uuid, text);

create or replace function public.set_course_offering_status(
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
  v_ended timestamptz;
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

  select status, ended_at into v_current, v_ended
  from public.course_offerings
  where id = p_offering_id
  for update;

  if v_current is null then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;

  -- F-8 2-7: 종료 뒤 상태 변경 거부
  if v_ended is not null then
    raise exception '종료된 수업입니다. 종료를 취소한 뒤에 상태를 변경하세요.';
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
-- 5. cancel_course_offering (F-2판 기반: 종강 뒤 폐강 거부)
-- =====================================================================
drop function if exists public.cancel_course_offering(uuid, text, uuid, text);

create or replace function public.cancel_course_offering(
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
  v_ends_at timestamptz;
  v_order record;
  v_action_count integer := 0;
begin
  if p_actor is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 폐강할 수 있습니다.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '폐강 사유를 입력해야 합니다.';
  end if;

  select status, ended_at, ends_at into v_current, v_ended, v_ends_at
  from public.course_offerings
  where id = p_offering_id
  for update;

  if v_current is null then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_ended is not null then
    raise exception '이미 종료된 개설강의는 폐강할 수 없습니다. 종료를 취소한 뒤에 폐강하세요.';
  end if;

  -- F-8 2-6: 종강(ends_at <= now()) 뒤 폐강 거부
  if v_ends_at is not null and v_ends_at <= now() then
    raise exception '모든 회차가 끝난 수업은 폐강이 아니라 종료합니다. 종료한 뒤 필요한 학생만 개별 환불하세요.';
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
