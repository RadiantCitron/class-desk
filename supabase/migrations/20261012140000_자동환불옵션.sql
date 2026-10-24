-- =====================================================================
-- 자동 환불 옵션
-- 1. course_offerings.auto_refund 컬럼 추가 (기본 false)
-- 2. update_course_offering: 허용 키에 'auto_refund' 추가 및 원장 기록
-- 3. begin_refund_request: p_source 허용 값에 'AUTO' 추가 및 p_actor_id(학생) 검증
-- 4. record_payment_event: source in ('ADMIN', 'AUTO') 분기 처리
-- =====================================================================

-- 1. course_offerings 에 auto_refund 추가
alter table public.course_offerings
  add column if not exists auto_refund boolean not null default false;

drop function if exists public.update_course_offering(uuid, uuid, text, text, jsonb);
drop function if exists public.update_course_offering(uuid, uuid, text, text, jsonb, boolean);

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
    'discord_role_id', 'discord_channel_id', 'auto_approve', 'auto_refund', 'manual_end', 'capacity', 'price'
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
  v_auto_refund boolean;
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
  v_terms := v_old.required_terms_types;
  v_auto := v_old.auto_approve;
  v_auto_refund := v_old.auto_refund;
  v_manual := v_old.manual_end;
  v_cap := v_old.capacity;
  v_rem := v_old.remaining_seats;
  v_price := v_old.price;
  v_grants := coalesce(v_old.grants, '[]'::jsonb);

  if p_patch ? 'label' then
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
      raise exception '모집 시작 시각은 ISO 문자열이어야 합니다.';
    end if;
    v_recruit := (p_patch ->> 'recruit_opens_at')::timestamptz;
    if v_recruit is null then
      raise exception '모집 시작 시각이 필요합니다.';
    end if;
    if v_recruit >= v_old.opens_at then
      raise exception '모집 시작은 개강보다 앞이어야 합니다.';
    end if;
    if v_recruit is distinct from v_old.recruit_opens_at then
      v_changes := v_changes || jsonb_build_object(
        'recruit_opens_at', jsonb_build_object('from', v_old.recruit_opens_at, 'to', v_recruit)
      );
    end if;
  end if;

  if p_patch ? 'required_terms_types' then
    if jsonb_typeof(p_patch -> 'required_terms_types') <> 'array' then
      raise exception '필수 약관은 문자열 배열이어야 합니다.';
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

  if p_patch ? 'auto_refund' then
    if jsonb_typeof(p_patch -> 'auto_refund') <> 'boolean' then
      raise exception '자동환불은 true/false여야 합니다.';
    end if;
    v_auto_refund := (p_patch ->> 'auto_refund')::boolean;
    if v_auto_refund is distinct from v_old.auto_refund then
      v_changes := v_changes || jsonb_build_object('auto_refund', jsonb_build_object('from', v_old.auto_refund, 'to', v_auto_refund));
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
      raise exception '정원은 양의 정수여야 합니다.';
    end if;
    v_cap := (p_patch ->> 'capacity')::int;
    if v_cap <= 0 then
      raise exception '정원은 1명 이상이어야 합니다.';
    end if;
    v_occupied := v_old.capacity - v_old.remaining_seats;
    if v_cap < v_occupied then
      raise exception '정원을 현재 점유 좌석(%명)보다 작게 줄일 수 없습니다.', v_occupied;
    end if;
    v_rem := v_cap - v_occupied;
    if v_cap is distinct from v_old.capacity then
      v_changes := v_changes || jsonb_build_object(
        'capacity', jsonb_build_object('from', v_old.capacity, 'to', v_cap),
        'remaining_seats', jsonb_build_object('from', v_old.remaining_seats, 'to', v_rem)
      );
    end if;
  end if;

  if (p_patch ? 'discord_role_id') or (p_patch ? 'discord_channel_id') then
    select e ->> 'discord_role_id', e ->> 'discord_channel_id'
      into v_cur_role, v_cur_channel
      from jsonb_array_elements(v_old.grants) as e
      where e ->> 'type' = 'DISCORD_ROLE'
      limit 1;

    v_role := v_cur_role;
    v_channel := v_cur_channel;

    if p_patch ? 'discord_role_id' then
      v_role := nullif(btrim(p_patch ->> 'discord_role_id'), '');
    end if;
    if p_patch ? 'discord_channel_id' then
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
      auto_refund = v_auto_refund,
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

-- 3. begin_refund_request 재작성: 허용 p_source 에 'AUTO' 추가
create or replace function public.begin_refund_request(
  p_order_id uuid,
  p_request_key text,
  p_amount integer,
  p_reason text,
  p_source text,
  p_student_request_event_id uuid default null::uuid,
  p_schedule_change_notice_event_id uuid default null::uuid,
  p_post_close boolean default false,
  p_actor_id uuid default null::uuid,
  p_batch_id uuid default null::uuid,
  p_operator_cause boolean default false
)
returns table(
  outcome text,
  request_event_id uuid,
  provider text,
  provider_transaction_id text,
  refundable integer,
  payment_amount integer
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_key text;
  v_existing record;
  v_paid record;
  v_refunded_sum integer;
  v_refundable integer;
  v_amount integer;
  v_open record;
  v_after_close boolean;
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
  if p_source is null or p_source not in ('ADMIN', 'OFFERING_CANCEL', 'AUTO') then
    raise exception '환불 출처는 ADMIN, OFFERING_CANCEL 또는 AUTO만 허용됩니다.';
  end if;
  if p_source in ('ADMIN', 'OFFERING_CANCEL', 'AUTO') and p_actor_id is null then
    raise exception '환불 요청에는 행위자 ID(p_actor_id)가 필수입니다.';
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
      || case when p_actor_id is not null
           then jsonb_build_object('actor_user_id', p_actor_id)
           else '{}'::jsonb end
      || case when p_student_request_event_id is not null
           then jsonb_build_object('student_request_event_id', p_student_request_event_id)
           else '{}'::jsonb end
      || case when p_schedule_change_notice_event_id is not null
           then jsonb_build_object('schedule_change_notice_event_id', p_schedule_change_notice_event_id)
           else '{}'::jsonb end
      || case when p_post_close is true
           then jsonb_build_object('post_close', true)
           else '{}'::jsonb end
      || case when p_batch_id is not null
           then jsonb_build_object('batch_id', p_batch_id)
           else '{}'::jsonb end
      || case when p_operator_cause is true
           then jsonb_build_object('operator_cause', true)
           else '{}'::jsonb end,
    jsonb_build_object('requested_amount', v_amount, 'refundable_before', v_refundable)
  )
  returning id into request_event_id;

  outcome := 'CREATED';
  provider := v_paid.provider;
  provider_transaction_id := v_paid.provider_transaction_id;
  refundable := v_refundable;
  payment_amount := v_paid.amount;
  return next;
end;
$$;

revoke execute on function public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean, uuid, uuid, boolean) to service_role;

-- 4. record_payment_event: source in ('ADMIN', 'AUTO') 분기 처리
create or replace function public.record_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_amount integer,
  p_currency text,
  p_order_id uuid,
  p_payment_method text,
  p_metadata jsonb,
  p_raw_payload jsonb,
  p_provider_transaction_id text default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_event_id uuid;
  v_cause text;
  v_reason text;
  v_req record;
  v_paid_amount integer;
  v_refunded_sum integer;
  v_refundable integer;
begin
  if p_order_id is null then
    raise exception '존재하지 않는 주문: %', p_order_id;
  end if;

  if p_provider = 'MANUAL' and p_event_type = 'REFUNDED' then
    select pe.amount into v_paid_amount
    from public.payment_events pe
    where pe.order_id = p_order_id
      and pe.event_type = 'PAYMENT_SUCCEEDED'
    order by pe.created_at desc
    limit 1;

    select coalesce(sum(pe.amount), 0) into v_refunded_sum
    from public.payment_events pe
    where pe.order_id = p_order_id
      and pe.event_type = 'REFUNDED';

    v_refundable := coalesce(v_paid_amount, 0) - v_refunded_sum;
    if v_refundable < 0 then
      v_refundable := 0;
    end if;

    if p_amount <= 0 or p_amount > v_refundable then
      raise exception '환불 금액(%원)이 남은 환불 가능액(%원)을 초과합니다.', p_amount, v_refundable;
    end if;
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
    if p_metadata->>'source' = 'ADMIN_MANUAL_REFUND' then
      if (p_metadata->>'post_close')::boolean is true then
        v_cause := 'POST_CLOSE_REFUND';
      elsif (p_metadata->>'operator_cause')::boolean is true then
        v_cause := 'OPERATOR_REFUND';
      else
        v_cause := 'ADMIN_REFUND';
      end if;
      v_reason := p_metadata->>'reason';
    else
      select pe.metadata->>'source' as source, pe.metadata->>'reason' as reason,
             pe.metadata->>'student_request_event_id' as student_request_event_id,
             pe.metadata->>'schedule_change_notice_event_id' as schedule_change_notice_event_id,
             (pe.metadata->>'post_close')::boolean as post_close,
             (pe.metadata->>'operator_cause')::boolean as operator_cause
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

      if v_req.post_close is true then
        v_cause := 'POST_CLOSE_REFUND';
        v_reason := v_req.reason;
      elsif v_req.source in ('ADMIN', 'AUTO') then
        -- 우선순위: 일정 변경 안내 id > 우리 사정(operator_cause) > 학생 신청 id 또는 AUTO > ADMIN_REFUND
        v_cause := case
          when v_req.schedule_change_notice_event_id is not null then 'SCHEDULE_CHANGE'
          when v_req.operator_cause is true then 'OPERATOR_REFUND'
          when v_req.student_request_event_id is not null or v_req.source = 'AUTO' then 'STUDENT_REFUND'
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
$$;

revoke execute on function public.record_payment_event(
  text, text, text, integer, text, uuid, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.record_payment_event(
  text, text, text, integer, text, uuid, text, jsonb, jsonb, text
) to service_role;
