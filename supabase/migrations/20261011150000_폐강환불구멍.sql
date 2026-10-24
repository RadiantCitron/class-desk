-- F-6: 폐강 완료 조건 보강 · PG 외 환불 상한 · 환불 원장 행위자 · 이용권 행 불변
--
-- 변경 내역:
--   1. orders CHECK 제약:
--      - refunded_amount <= final_amount (환불 누적액이 결제 확정액을 초과할 수 없음)
--   2. begin_refund_request (F-7판 기반):
--      - p_actor_id uuid 추가 (기존 8인자 drop 후 9인자 신설)
--      - p_source in ('ADMIN', 'OFFERING_CANCEL') 시 p_actor_id 필수 검증
--      - metadata 에 actor_user_id: p_actor_id 기록
--   3. record_payment_event (F-7판 기반):
--      - provider = 'MANUAL' AND event_type = 'REFUNDED' 시 환불 가능액(성공 합 - 환불 합) 초과 거부
--   4. complete_course_offering_cancel (F-2판 기반):
--      - p_acknowledged jsonb default '[]'::jsonb 인자 추가
--      - CANCEL_COMPLETED 사건에 after.acknowledged_unrefunded 기록
--   5. entitlements 행 불변 트리거:
--      - before update or delete 트리거 설치
--      - anon, authenticated, service_role 역할에 대해:
--        * DELETE 거부
--        * UPDATE: revoked_at IS NULL -> NOT NULL (revoked_reason 동반) 1회만 허용
--        * UPDATE: discord_role_removed_at IS NULL -> NOT NULL 1회만 허용
--        * 그 외 컬럼 변경, 기 설정값 수정/삭제 거부

-- =====================================================================
-- 1. orders CHECK 제약 추가
-- =====================================================================
alter table public.orders
  drop constraint if exists orders_refunded_amount_lte_final;

alter table public.orders
  add constraint orders_refunded_amount_lte_final
    check (refunded_amount <= final_amount);

-- =====================================================================
-- 2. begin_refund_request — p_actor_id 추가 (9인자)
-- =====================================================================
drop function if exists public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean);
drop function if exists public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean, uuid);

create or replace function public.begin_refund_request(
  p_order_id uuid,
  p_request_key text,
  p_amount integer,
  p_reason text,
  p_source text,
  p_student_request_event_id uuid default null::uuid,
  p_schedule_change_notice_event_id uuid default null::uuid,
  p_post_close boolean default false,
  p_actor_id uuid default null::uuid
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
  if p_source is null or p_source not in ('ADMIN', 'OFFERING_CANCEL') then
    raise exception '환불 출처는 ADMIN 또는 OFFERING_CANCEL만 허용됩니다.';
  end if;
  if p_source in ('ADMIN', 'OFFERING_CANCEL') and p_actor_id is null then
    raise exception '관리자 환불 요청에는 행위자 ID(p_actor_id)가 필수입니다.';
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

  -- 최신 PAYMENT_SUCCEEDED
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

revoke execute on function public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.begin_refund_request(uuid, text, integer, text, text, uuid, uuid, boolean, uuid) to service_role;

-- =====================================================================
-- 3. record_payment_event: MANUAL 환불 상한 검사
-- =====================================================================
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

  -- PG 외(MANUAL) 환불 상한 검사: 결제 모듈 자기 원장(payment_events) 기준
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
      else
        v_cause := 'ADMIN_REFUND';
      end if;
      v_reason := p_metadata->>'reason';
    else
      select pe.metadata->>'source' as source, pe.metadata->>'reason' as reason,
             pe.metadata->>'student_request_event_id' as student_request_event_id,
             pe.metadata->>'schedule_change_notice_event_id' as schedule_change_notice_event_id,
             (pe.metadata->>'post_close')::boolean as post_close
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
      elsif v_req.source = 'ADMIN' then
        v_cause := case
          when v_req.schedule_change_notice_event_id is not null then 'SCHEDULE_CHANGE'
          when v_req.student_request_event_id is not null then 'STUDENT_REFUND'
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

revoke execute on function public.record_payment_event(text, text, text, integer, text, uuid, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_payment_event(text, text, text, integer, text, uuid, text, jsonb, jsonb, text) to service_role;

-- =====================================================================
-- 4. complete_course_offering_cancel: p_acknowledged jsonb 인자 지원
-- =====================================================================
drop function if exists public.complete_course_offering_cancel(uuid, uuid, text);
drop function if exists public.complete_course_offering_cancel(uuid, uuid, text, jsonb);

create function public.complete_course_offering_cancel(
  p_offering_id uuid,
  p_actor uuid,
  p_actor_role text,
  p_acknowledged jsonb default '[]'::jsonb
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
    jsonb_build_object(
      'status', 'CANCELLED',
      'acknowledged_unrefunded', coalesce(p_acknowledged, '[]'::jsonb)
    ),
    clock_timestamp()
  );
end;
$$;

revoke execute on function public.complete_course_offering_cancel(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.complete_course_offering_cancel(uuid, uuid, text, jsonb) to service_role;

-- =====================================================================
-- 5. entitlements 행 불변 트리거
-- =====================================================================
create or replace function public.entitlements_guard_immutable()
returns trigger
language plpgsql
as $$
begin
  -- postgres (슈퍼유저/마이그레이션 실행자)는 통과
  if current_user not in ('anon', 'authenticated', 'service_role') then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception '이용권 행은 삭제할 수 없습니다.'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'UPDATE' then
    -- 불변 컬럼 변조 검사
    if new.id is distinct from old.id
       or new.user_id is distinct from old.user_id
       or new.type is distinct from old.type
       or new.order_id is distinct from old.order_id
       or new.payment_event_id is distinct from old.payment_event_id
       or new.grant_source is distinct from old.grant_source
       or new.grant_event_id is distinct from old.grant_event_id
       or new.access_code is distinct from old.access_code
       or new.max_uses is distinct from old.max_uses
       or new.expires_at is distinct from old.expires_at
       or new.metadata is distinct from old.metadata
       or new.granted_at is distinct from old.granted_at then
      raise exception '이용권의 기본 정보는 수정할 수 없습니다.'
        using errcode = 'restrict_violation';
    end if;

    -- revoked_at / revoked_reason 변경 규칙:
    -- old.revoked_at 이 이미 있으면 revoked_at, revoked_reason 변경 불가
    if old.revoked_at is not null then
      if new.revoked_at is distinct from old.revoked_at
         or new.revoked_reason is distinct from old.revoked_reason then
        raise exception '이미 회수된 이용권의 회수 기록은 수정할 수 없습니다.'
          using errcode = 'restrict_violation';
      end if;
    else
      -- null -> not null 로 변경될 때는 revoked_reason 도 함께 지정되어야 함
      if new.revoked_at is not null and (new.revoked_reason is null or btrim(new.revoked_reason) = '') then
        raise exception '이용권 회수 시 회수 사유(revoked_reason)가 필수입니다.'
          using errcode = 'restrict_violation';
      end if;
    end if;

    -- discord_role_removed_at 변경 규칙:
    -- old.discord_role_removed_at 이 이미 있으면 변경 불가
    if old.discord_role_removed_at is not null then
      if new.discord_role_removed_at is distinct from old.discord_role_removed_at then
        raise exception '이미 기록된 디스코드 역할 제거 시각은 수정할 수 없습니다.'
          using errcode = 'restrict_violation';
      end if;
    end if;

    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists entitlements_guard_immutable_trigger on public.entitlements;

create trigger entitlements_guard_immutable_trigger
  before update or delete on public.entitlements
  for each row execute function public.entitlements_guard_immutable();

grant execute on function public.entitlements_guard_immutable() to service_role;
