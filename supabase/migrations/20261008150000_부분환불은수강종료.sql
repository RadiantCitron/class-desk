-- 부분 환불도 수강 포기다.
--
--  · 부분 환불이 반영되면 주문이 끝난다: 주문 CANCELLED, 결제는 PARTIALLY_REFUNDED(환불 누적 기록),
--    좌석 반환, ORDER_REFUNDED(이용권·디스코드 역할 회수). 첫 종료 때 한 번만.
--  · 이미 부분 환불로 끝난 주문(CANCELLED + PARTIALLY_REFUNDED)에 남은 금액 환불이 오면 DLQ가 아니라 누적 반영,
--    전액이 되면 REFUNDED로 마무리(종료 사건·좌석·아웃박스는 다시 만들지 않는다).
--    탈퇴 등으로 취소된 PAID 주문에 환불이 오면 지금처럼 DLQ.
--  · 취소 사건(order_events CANCELLED)의 payload에 수강 포기 사실을 싣는다:
--    cause, reason, refund_amount(이번), refunded_total(누적), final_amount, partial, first_class_date.
--  · 원인(cause)은 결제 모듈이 자기 원장(payment_events)에서 정해 PAYMENT_REFUNDED 사실에 싣는다
--    (주문 모듈은 payment_events를 읽지 않는다 — R1). 키 추가뿐이라 이미 쌓인 사실과 호환된다.
--
-- on_payment_refunded: 5인자를 지우고 p_cause·p_reason 기본값 null을 더한 7인자로 교체(옛 호출은 그대로 동작).

-- 1) record_payment_event — REFUNDED 사실에 cause·reason 추가(그 밖의 동작은 20260925150000과 같다)
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
set search_path = public
as $$
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
      select pe.metadata->>'source' as source, pe.metadata->>'reason' as reason
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
        v_cause := 'ADMIN_REFUND';
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

-- 2) on_payment_refunded — 부분 환불도 주문을 끝낸다
drop function if exists public.on_payment_refunded(uuid, uuid, text, integer, text);

create function public.on_payment_refunded(
  p_payment_event_id uuid,
  p_order_id uuid,
  p_provider text,
  p_amount integer,
  p_currency text,
  p_cause text default null,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_new_total integer;
  v_partial boolean;
  v_first_class_date date;
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

  -- 이미 취소된 주문(탈퇴 등)에 환불이 뒤늦게 오면 금액을 반영하지 않고 DLQ로 보낸다(§17-12).
  -- 단, 앞선 부분 환불로 끝난 주문(PARTIALLY_REFUNDED)에 남은 금액 환불이 오는 것은 정상이라 누적 반영한다.
  if v_order.status = 'CANCELLED' and v_order.payment_status is distinct from 'PARTIALLY_REFUNDED' then
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

  v_partial := v_new_total < v_order.final_amount;

  update public.orders
  set payment_status = case when v_partial then 'PARTIALLY_REFUNDED' else 'REFUNDED' end,
      refunded_at = case when v_partial then refunded_at else now() end,
      refunded_amount = v_new_total,
      refunded_event_ids = refunded_event_ids || p_payment_event_id,
      status = 'CANCELLED',
      cancelled_at = coalesce(cancelled_at, now())
  where id = v_order.id;

  -- 종료 사건·좌석 반환·회수 요청은 주문이 처음 끝날 때 한 번만(이미 끝난 주문의 추가 환불은 금액만 누적).
  if v_order.status is distinct from 'CANCELLED' and v_order.status is distinct from 'REJECTED' then
    if v_order.course_offering_id is not null then
      select (opens_at at time zone 'Asia/Seoul')::date into v_first_class_date
      from public.course_offerings
      where id = v_order.course_offering_id;
    end if;

    insert into public.order_events (event_type, actor, order_id, payload)
    values (
      'CANCELLED', 'SYSTEM', v_order.id,
      jsonb_build_object(
        'cause', p_cause,
        'reason', p_reason,
        'refund_amount', p_amount,
        'refunded_total', v_new_total,
        'final_amount', v_order.final_amount,
        'partial', v_partial,
        'first_class_date', v_first_class_date
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
  end if;
end;
$$;

revoke execute on function public.on_payment_refunded(uuid, uuid, text, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.on_payment_refunded(uuid, uuid, text, integer, text, text, text)
  to service_role;
