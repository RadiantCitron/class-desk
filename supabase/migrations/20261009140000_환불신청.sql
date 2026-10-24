-- 수강생 환불 신청·관리자 거절, 학생 신청에서 시작된 환불의 원인 구분.
--
--  · order_events 이벤트 종류에 REFUND_REQUESTED(학생 신청)·REFUND_REQUEST_REJECTED(관리자 거절)를 더한다. 새 테이블·승인 엔진은 없다.
--    열린 신청 = 그것을 가리키는 REJECTED(payload.request_event_id)가 없고 주문이 CANCELLED가 아닌 REFUND_REQUESTED.
--    (시각 비교를 쓰지 않는다 — 같은 트랜잭션의 이벤트는 created_at이 같을 수 있다. TS 쪽 정의: lib/shared/refund-request.ts)
--  · request_order_refund: 학생 본인의 승인됨+결제완료 **카드** 수업 주문에 열린 신청이 없을 때만 신청 사건을 남긴다. 제안(정책 표)은 DB가 판정하지 않는다
--    (표는 코드에만 있다 — ADR-0025) — 서버 액션이 같은 평가 함수로 계산한 요약을 p_proposal로 넘기면 그대로 사실로 저장한다.
--  · reject_order_refund_request(order, actor, actor_role, reason): 역할이 ADMIN일 때만(호출자가 레일로 확인한 값을 넘김), 열린 신청이 있을 때 사유와 함께 거절 사건을 남긴다. 거절해도 직권 환불은 막지 않는다.
--  · begin_refund_request: p_student_request_event_id(선택)를 받아 결제 원장 REFUND_REQUESTED 메타데이터에 싣고, record_payment_event가 그 값이 있으면
--    환불 원인을 STUDENT_REFUND로 정한다(없으면 예전처럼 ADMIN_REFUND). 그 밖의 분기는 S-4a(20261008150000)와 같다.
--  새 시그니처 grant는 같은 파일에.

-- 1. 이벤트 종류
alter table public.order_events drop constraint order_events_event_type_check;
alter table public.order_events
  add constraint order_events_event_type_check
    check (event_type = any (array[
      'APPLIED', 'APPROVED', 'REJECTED', 'CANCELLED', 'ACCESS_GRANTED', 'CLOSED', 'REFUND_REQUESTED', 'REFUND_REQUEST_REJECTED'
    ]));

-- 2. 학생 환불 신청
create function public.request_order_refund(
  p_order_id uuid,
  p_user_id uuid,
  p_reason text,
  p_proposal jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_event_id uuid;
begin
  select id, user_id, status, payment_status, payment_method, course_offering_id
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found or v_order.user_id is distinct from p_user_id then
    raise exception '내 신청 건이 아닙니다.';
  end if;
  if v_order.course_offering_id is null then
    raise exception '수업 신청 건만 환불을 신청할 수 있습니다.';
  end if;
  if v_order.status <> 'APPROVED' then
    raise exception '승인된 신청 건만 환불을 신청할 수 있습니다.';
  end if;
  if v_order.payment_status <> 'PAID' then
    raise exception '결제가 완료된 신청 건만 환불을 신청할 수 있습니다.';
  end if;
  if v_order.payment_method is distinct from 'CARD' then
    raise exception '카드로 결제한 건만 환불을 신청할 수 있습니다. 그 밖의 결제는 관리자에게 문의해 주세요.';
  end if;
  if v_reason = '' then
    raise exception '환불 사유를 입력해야 합니다.';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception '환불 사유는 1000자 이하로 입력해 주세요.';
  end if;

  if exists (
    select 1 from public.order_events r
    where r.order_id = p_order_id
      and r.event_type = 'REFUND_REQUESTED'
      and not exists (
        select 1 from public.order_events j
        where j.order_id = p_order_id
          and j.event_type = 'REFUND_REQUEST_REJECTED'
          and j.payload->>'request_event_id' = r.id::text
      )
  ) then
    raise exception '이미 환불을 신청했습니다. 관리자가 검토 중입니다.';
  end if;

  insert into public.order_events (event_type, actor, actor_user_id, order_id, payload)
  values (
    'REFUND_REQUESTED', 'STUDENT', p_user_id, p_order_id,
    jsonb_build_object(
      'reason', v_reason,
      'proposal', coalesce(p_proposal, '{}'::jsonb),
      'requested_on', (now() at time zone 'Asia/Seoul')::date
    )
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

-- 3. 관리자 거절
create function public.reject_order_refund_request(
  p_order_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_status text;
  v_request_id uuid;
  v_event_id uuid;
begin
  -- 역할은 호출자(서버 액션이 레일로 ADMIN을 확인한 뒤)가 넘긴다 — 주문 모듈은 회원 테이블을 읽지 않는다(R1, close_order_without_refund와 같은 방식).
  if p_actor_id is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 환불 신청을 거절할 수 있습니다.';
  end if;
  if v_reason = '' then
    raise exception '거절 사유를 입력해야 합니다.';
  end if;

  select status into v_status from public.orders where id = p_order_id for update;
  if not found then
    raise exception '신청 건을 찾을 수 없습니다.';
  end if;
  if v_status = 'CANCELLED' then
    raise exception '이미 종료된 신청 건입니다.';
  end if;

  select r.id into v_request_id
  from public.order_events r
  where r.order_id = p_order_id
    and r.event_type = 'REFUND_REQUESTED'
    and not exists (
      select 1 from public.order_events j
      where j.order_id = p_order_id
        and j.event_type = 'REFUND_REQUEST_REJECTED'
        and j.payload->>'request_event_id' = r.id::text
    )
  order by r.created_at desc, r.id desc
  limit 1;

  if v_request_id is null then
    raise exception '거절할 환불 신청이 없습니다.';
  end if;

  insert into public.order_events (event_type, actor, actor_user_id, order_id, payload)
  values ('REFUND_REQUEST_REJECTED', 'ADMIN', p_actor_id, p_order_id,
          jsonb_build_object('reason', v_reason, 'request_event_id', v_request_id))
  returning id into v_event_id;

  return v_event_id;
end;
$$;

revoke execute on function public.request_order_refund(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.request_order_refund(uuid, uuid, text, jsonb) to service_role;
revoke execute on function public.reject_order_refund_request(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.reject_order_refund_request(uuid, uuid, text, text) to service_role;

-- 4. begin_refund_request — 학생 신청 연결(선택 인자)
drop function public.begin_refund_request(uuid, text, integer, text, text);

CREATE OR REPLACE FUNCTION public.begin_refund_request(p_order_id uuid, p_request_key text, p_amount integer, p_reason text, p_source text, p_student_request_event_id uuid DEFAULT NULL)
 RETURNS TABLE(outcome text, request_event_id uuid, provider text, provider_transaction_id text, refundable integer, payment_amount integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_key text;
  v_existing record;
  v_paid record;
  v_refunded_sum integer;
  v_refundable integer;
  v_amount integer;
  v_open record;
  v_after_close boolean;
  v_new_id uuid;
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
      || case when p_student_request_event_id is not null
           then jsonb_build_object('student_request_event_id', p_student_request_event_id)
           else '{}'::jsonb end,
    '{}'::jsonb
  )
  returning id into v_new_id;

  outcome := 'CREATED';
  request_event_id := v_new_id;
  provider := v_paid.provider;
  provider_transaction_id := v_paid.provider_transaction_id;
  refundable := v_refundable;
  payment_amount := v_paid.amount;
  return next;
end;
$function$;

revoke execute on function public.begin_refund_request(uuid, text, integer, text, text, uuid) from public, anon, authenticated;
grant execute on function public.begin_refund_request(uuid, text, integer, text, text, uuid) to service_role;

-- 5. record_payment_event — 환불 원인 STUDENT_REFUND
CREATE OR REPLACE FUNCTION public.record_payment_event(p_provider text, p_provider_event_id text, p_event_type text, p_amount integer, p_currency text, p_order_id uuid, p_payment_method text, p_metadata jsonb, p_raw_payload jsonb, p_provider_transaction_id text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_event_id uuid;
  v_cause text;
  v_reason text;
  v_req record;
begin
  if p_order_id is null then
    raise exception '존재하지 않는 주문: %', p_order_id;
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
    -- 환불 원인: PG 외 환불 반영 > 아직 닫히지 않은 우리 환불 요청의 출처 > 요청 없는 외부 취소
    if p_metadata->>'source' = 'ADMIN_MANUAL_REFUND' then
      v_cause := 'ADMIN_REFUND';
      v_reason := p_metadata->>'reason';
    else
      select pe.metadata->>'source' as source, pe.metadata->>'reason' as reason,
             pe.metadata->>'student_request_event_id' as student_request_event_id
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

      if v_req.source = 'ADMIN' then
        -- 학생의 환불 신청에서 시작된 관리자 환불이면 원인을 구분한다 — 라벨 「수강 포기」의 근거는 같지만 누가 시작했는지가 다르다.
        v_cause := case when v_req.student_request_event_id is not null then 'STUDENT_REFUND' else 'ADMIN_REFUND' end;
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
$function$;
