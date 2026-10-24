-- F-9: 계약 조건 변경과 탈퇴·감시
--
-- 변경 내역:
--   1. order_events_event_type_check:
--      - GRANTS_REISSUED, NO_REFUND_DECIDED 추가
--   2. revoke_entitlements:
--      - p_type text default null 추가 (종류 지정 시 해당 종류만 회수)
--      - 사유 목록에 'GRANTS_REISSUED' 추가
--   3. update_course_offering:
--      - location 수정 시: 살아있는 신청(PENDING, APPROVED)이 있고, 종료 전(ended_at is null)이며, 시작 전 활성 회차가 1개 이상이면 거부 ('신청자가 있는 수업의 장소는 「수업 조건 변경」으로 바꿉니다(수강생 안내·동의)')
--      - p_reissue_discord boolean default false 추가
--      - discord_role_id 변경 + p_reissue_discord = true 시 승인/결제완료(APPROVED & PAID/WAIVED) 주문들에 GRANTS_REISSUED 주문 사건 + outbox ORDER_GRANTS_REISSUED 발행
--      - 원장 UPDATED 에 reissue_existing: true/false 기록
--   4. apply_schedule_change:
--      - p_location text default null 추가 (기존 6인자 drop 후 7인자 신설)
--      - 일정 및/또는 장소 변경 지원 (둘 다 변경 없을 때 거부)
--      - 변경 시 장소 업데이트 및 원장 SCHEDULE_CHANGED 의 after.location 기록
--      - 주문별 안내 SCHEDULE_CHANGE_NOTICE 의 before/after 에 location 기록
--   5. decide_no_refund:
--      - 관리자 직권으로 취소(CANCELLED)된 주문에 대해 「환불하지 않고 마무리」 결정 함수 신설
--      - 주문 사건 NO_REFUND_DECIDED 기록
--   6. cancel_orders_for_withdrawn_user:
--      - 취소 사건 payload 에 { cause: 'WITHDRAWN', payment_status, final_amount } 기록
--   7. on_payment_refunded:
--      - 환불 취소 사건 payload 에 offering_ended: boolean 기록

-- =====================================================================
-- 1. order_events 및 outbox_messages CHECK 제약 확장
-- =====================================================================
alter table public.order_events drop constraint if exists order_events_event_type_check;
alter table public.order_events
  add constraint order_events_event_type_check
    check (event_type = any (array[
      'APPLIED', 'APPROVED', 'REJECTED', 'CANCELLED', 'ACCESS_GRANTED', 'CLOSED', 'REFUND_REQUESTED', 'REFUND_REQUEST_REJECTED',
      'SCHEDULE_CHANGE_NOTICE', 'SCHEDULE_CHANGE_ACCEPTED', 'SCHEDULE_CHANGE_DECLINED',
      'REFUND_APPLIED',
      'GRANTS_REISSUED', 'NO_REFUND_DECIDED'
    ]));

alter table public.outbox_messages drop constraint if exists outbox_messages_topic_check;
alter table public.outbox_messages
  add constraint outbox_messages_topic_check
    check (
      (topic = any (array[
        'PAYMENT_SUCCEEDED', 'PAYMENT_REFUNDED', 'ORDER_PAID', 'ORDER_REFUNDED',
        'USER_WITHDRAWN', 'ORDER_OFFERING_CANCELLED', 'ORDER_ACCESS_GRANTED',
        'ORDER_CLOSED', 'ORDER_COURSE_ENDED', 'ORDER_GRANTS_REISSUED'
      ]))
      or (
        (topic = any (array['GRANT_ENTITLEMENTS', 'REVOKE_ENTITLEMENTS', 'SEND_EMAIL', 'DISCORD_LINKED']))
        and processed_at is not null
      )
    );

-- =====================================================================
-- 2. revoke_entitlements 확장 (p_type 인자 및 GRANTS_REISSUED 사유)
-- =====================================================================
drop function if exists public.revoke_entitlements(uuid, uuid, text);
drop function if exists public.revoke_entitlements(uuid, uuid, text, text);

create or replace function public.revoke_entitlements(
  p_user_id uuid,
  p_order_id uuid,
  p_reason text,
  p_type text default null
)
returns table (entitlement_id uuid, role_id text, still_active boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_reason is null or p_reason not in ('REFUNDED', 'WITHDRAWN', 'COURSE_ENDED', 'ADMIN_CLOSED', 'GRANTS_REISSUED') then
    raise exception '알 수 없는 회수 사유입니다: %', p_reason;
  end if;

  update public.entitlements e
  set revoked_at = now(), revoked_reason = p_reason
  where e.user_id = p_user_id
    and e.revoked_at is null
    and (p_order_id is null or e.order_id = p_order_id)
    and (p_type is null or e.type = p_type);

  return query
  select
    e.id,
    e.metadata->>'discord_role_id',
    exists (
      select 1 from public.entitlements a
      where a.user_id = p_user_id
        and a.type = 'DISCORD_ROLE'
        and a.revoked_at is null
        and a.metadata->>'discord_role_id' = e.metadata->>'discord_role_id'
    )
  from public.entitlements e
  where e.user_id = p_user_id
    and e.type = 'DISCORD_ROLE'
    and e.revoked_reason = p_reason
    and e.revoked_at is not null
    and e.discord_role_removed_at is null
    and e.metadata ? 'discord_role_id'
    and (p_order_id is null or e.order_id = p_order_id)
    and (p_type is null or e.type = p_type);
end;
$$;

revoke execute on function public.revoke_entitlements(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.revoke_entitlements(uuid, uuid, text, text) to service_role;


-- =====================================================================
-- 3. update_course_offering (장소 거부 및 디스코드 재부여 지원)
-- =====================================================================
drop function if exists public.update_course_offering(uuid, uuid, text, text, jsonb);
drop function if exists public.update_course_offering(uuid, uuid, text, text, jsonb, boolean);

create function public.update_course_offering(
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
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception '개설강의를 수정할 수 없습니다(권한 또는 상태를 확인하세요).';
  end if;

  -- before / after 추출
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

  -- 원장 기록 (UPDATED)
  insert into public.course_offering_events (
    id, course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    v_event_id, p_offering_id, 'UPDATED', 'ADMIN', p_actor, btrim(p_reason),
    v_before, v_after, clock_timestamp()
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
-- 4. apply_schedule_change (p_location 추가 및 수업 조건 변경 지원)
-- =====================================================================
drop function if exists public.apply_schedule_change(uuid, uuid, text, text, uuid[], jsonb);
drop function if exists public.apply_schedule_change(uuid, uuid, text, text, uuid[], jsonb, text);

create function public.apply_schedule_change(
  p_offering_id uuid,
  p_actor uuid,
  p_actor_role text,
  p_reason text,
  p_cancel_session_ids uuid[],
  p_add_sessions jsonb,
  p_location text default null
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
  uuid, uuid, text, text, uuid[], jsonb, text
) from public, anon, authenticated;
grant execute on function public.apply_schedule_change(
  uuid, uuid, text, text, uuid[], jsonb, text
) to service_role;


-- =====================================================================
-- 5. decide_no_refund (신설)
-- =====================================================================
create or replace function public.decide_no_refund(
  p_order_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_actor_id is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 결정할 수 있습니다.';
  end if;
  if v_reason = '' then
    raise exception '사유를 입력해야 합니다.';
  end if;

  select id, status into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception '주문을 찾을 수 없습니다.';
  end if;
  if v_order.status <> 'CANCELLED' then
    raise exception '종료(취소)된 신청 건만 환불하지 않고 마무리할 수 있습니다.';
  end if;

  insert into public.order_events (event_type, actor, actor_user_id, order_id, payload, created_at)
  values (
    'NO_REFUND_DECIDED', 'ADMIN', p_actor_id, p_order_id,
    jsonb_build_object('reason', v_reason),
    clock_timestamp()
  );
end;
$$;

revoke execute on function public.decide_no_refund(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.decide_no_refund(uuid, uuid, text, text) to service_role;


-- =====================================================================
-- 6. cancel_orders_for_withdrawn_user (원인 payload 기록)
-- =====================================================================
create or replace function public.cancel_orders_for_withdrawn_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
begin
  for v_order in (
    select id, status, payment_status, final_amount, course_offering_id
    from public.orders
    where user_id = p_user_id
      and status in ('PENDING', 'APPROVED')
    for update
  ) loop
    update public.orders
    set status = 'CANCELLED',
        cancelled_at = now()
    where id = v_order.id;

    insert into public.order_events (event_type, actor, order_id, payload)
    values (
      'CANCELLED', 'SYSTEM', v_order.id,
      jsonb_build_object(
        'cause', 'WITHDRAWN',
        'payment_status', v_order.payment_status,
        'final_amount', v_order.final_amount
      )
    );

    if v_order.course_offering_id is not null then
      perform public.release_course_offering_seat(v_order.course_offering_id);
    end if;
  end loop;
end;
$$;

revoke execute on function public.cancel_orders_for_withdrawn_user(uuid) from public, anon, authenticated;
grant execute on function public.cancel_orders_for_withdrawn_user(uuid) to service_role;


-- =====================================================================
-- 7. on_payment_refunded (offering_ended 기록)
-- =====================================================================
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
  v_offering_ended boolean := false;
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

  if v_order.status <> 'CANCELLED' and v_effective_cause = 'POST_CLOSE_REFUND' then
    v_effective_cause := 'ADMIN_REFUND';
  end if;

  if v_order.course_offering_id is not null then
    select (ended_at is not null) into v_offering_ended
    from public.course_offerings
    where id = v_order.course_offering_id;
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
        'past_sessions', v_past_sessions,
        'offering_ended', v_offering_ended
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
    insert into public.order_events (event_type, actor, order_id, payload)
    values (
      'REFUND_APPLIED', 'SYSTEM', v_order.id,
      jsonb_build_object(
        'cause', v_effective_cause,
        'reason', p_reason,
        'refund_amount', p_amount,
        'refunded_total', v_new_total,
        'final_amount', v_order.final_amount,
        'offering_ended', v_offering_ended
      ) || case when v_effective_cause = 'POST_CLOSE_REFUND'
             then jsonb_build_object('post_close', true)
             else '{}'::jsonb end
    );
  end if;
end;
$function$;

revoke execute on function public.on_payment_refunded(uuid, uuid, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.on_payment_refunded(uuid, uuid, text, integer, text, text, text) to service_role;
