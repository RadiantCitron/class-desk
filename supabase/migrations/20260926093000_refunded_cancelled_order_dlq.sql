-- 전수조사(2026-09-26): H단계가 A단계의 5인자 on_payment_refunded를 바꾸지 않고
-- 1인자 오버로드를 다시 만들었다. 실제 환불 경로(페이로드 5인자)에는
-- "이미 취소된 주문 → DLQ"(§17-12)가 없고, 1인자 함수는 payment_events를 읽어
-- 주문→결제 읽기 위반이 된다. 1인자는 지우고, 5인자에 그 분기를 넣는다.

drop function if exists public.on_payment_refunded(uuid);

create or replace function public.on_payment_refunded(
  p_payment_event_id uuid,
  p_order_id uuid,
  p_provider text,
  p_amount integer,
  p_currency text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_new_total integer;
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
  if v_order.status = 'CANCELLED' then
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

  if v_new_total < v_order.final_amount then
    update public.orders
    set refunded_amount = v_new_total,
        refunded_event_ids = refunded_event_ids || p_payment_event_id,
        payment_status = 'PARTIALLY_REFUNDED'
    where id = v_order.id;
    return;
  end if;

  update public.orders
  set payment_status = 'REFUNDED',
      refunded_at = now(),
      refunded_amount = v_new_total,
      refunded_event_ids = refunded_event_ids || p_payment_event_id,
      status = 'CANCELLED',
      cancelled_at = coalesce(cancelled_at, now())
  where id = v_order.id;

  if v_order.status is distinct from 'CANCELLED' and v_order.status is distinct from 'REJECTED' then
    insert into public.order_events (event_type, actor, order_id)
    values ('CANCELLED', 'SYSTEM', v_order.id);

    if v_order.course_offering_id is not null then
      perform public.release_course_offering_seat(v_order.course_offering_id);
    end if;
  end if;

  insert into public.outbox_messages (topic, payload)
  values (
    'ORDER_REFUNDED',
    jsonb_build_object('order_id', v_order.id, 'user_id', v_order.user_id, 'payment_event_id', p_payment_event_id)
  );
end;
$$;
