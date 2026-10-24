-- H단계 — 탈퇴 시 주문 취소와 권한 해제.

-- 1) 주문 모듈: 탈퇴 회원의 수강 중·결제 전 신청을 전부 취소한다(사유: 회원탈퇴).
--    on_payment_refunded와 같은 모양: 잠금 → 조건별 분기 → 취소 이력 → 좌석 반환.
--    결제완료(PAID)·부분환불(PARTIALLY_REFUNDED) 주문도 여기서 취소된다 — payment_status는
-- 건드리지 않는다(금액 정산은 이 함수의 일이 아니다).
create function public.cancel_orders_for_withdrawn_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
begin
  for v_order in (
    select id, status, course_offering_id
    from public.orders
    where user_id = p_user_id
      and status in ('PENDING', 'APPROVED')
    for update
  ) loop
    update public.orders
    set status = 'CANCELLED',
        cancelled_at = now()
    where id = v_order.id;

    insert into public.order_events (event_type, actor, order_id)
    values ('CANCELLED', 'SYSTEM', v_order.id);

    if v_order.course_offering_id is not null then
      perform public.release_course_offering_seat(v_order.course_offering_id);
    end if;
  end loop;
end;
$$;

revoke execute on function public.cancel_orders_for_withdrawn_user(uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_orders_for_withdrawn_user(uuid)
  to service_role;

-- 2) 회원 모듈: withdraw_user()에 ADMIN 거부 + 매니저 자동 강등을 추가한다(create or replace로
--    권한 유지 — 시그니처 안 바뀜).
create or replace function public.withdraw_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  select role into v_role from public.users where id = p_user_id for update;

  if v_role = 'ADMIN' then
    raise exception 'ADMIN 계정은 앱에서 탈퇴할 수 없습니다.';
  end if;

  update public.users set withdrawn_at = now()
  where id = p_user_id and withdrawn_at is null;
  if not found then
    raise exception '이미 탈퇴했거나 회원을 찾을 수 없습니다.';
  end if;

  if v_role = 'MANAGER' then
    perform public.revoke_manager(p_user_id, '회원탈퇴', p_user_id);
  end if;

  insert into public.account_events (user_id, event_type, actor)
  values (p_user_id, 'WITHDRAWN', 'SELF');

  insert into public.outbox_messages (topic, payload)
  values ('USER_WITHDRAWN', jsonb_build_object('user_id', p_user_id));
end;
$$;

-- 3) on_payment_refunded — 이미 취소된 주문(탈퇴로 취소됐을 수 있음)에 환불이 뒤늦게 오면
-- 반영하지 않고 DLQ로 보낸다.
create or replace function public.on_payment_refunded(p_payment_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pe record;
  v_order record;
  v_new_total integer;
begin
  select id, provider, order_id, amount, currency
    into v_pe
  from public.payment_events
  where id = p_payment_event_id;

  if v_pe.id is null then
    raise exception '결제 이벤트를 찾을 수 없습니다: %', p_payment_event_id;
  end if;

  select id, user_id, status, payment_status, final_amount, course_offering_id,
         refunded_amount, refunded_event_ids
    into v_order
  from public.orders
  where id = v_pe.order_id
  for update;

  -- 멱등: 이미 반영한 환불 이벤트(부분·전액 모두 refunded_event_ids에 남는다)이거나, 이미 DLQ로
  -- 결론 낸 이벤트면 아무것도 안 한다. 잠금 뒤에 확인해야 동시 처리에서도 한 번만 반영된다.
  if p_payment_event_id = any(v_order.refunded_event_ids)
     or exists (
       select 1 from public.dead_letters
       where payload->>'handler' = 'on_payment_refunded'
         and payload->>'payment_event_id' = p_payment_event_id::text
     ) then
    return;
  end if;

  if v_order.status = 'CANCELLED' then
    insert into public.dead_letters (source, payload, error_message)
    values (
      v_pe.provider,
      jsonb_build_object('handler', 'on_payment_refunded', 'payment_event_id', v_pe.id, 'order_id', v_order.id),
      '이미 취소된 주문(탈퇴 등)에 환불 이벤트가 들어옴(상태 반영 안 함, 대사 확인 필요) — order_id='
        || v_order.id::text || ', payment_event_id=' || v_pe.id::text
    );
    return;
  end if;

  if v_order.payment_status not in ('PAID', 'PARTIALLY_REFUNDED') then
    insert into public.dead_letters (source, payload, error_message)
    values (
      v_pe.provider,
      jsonb_build_object('handler', 'on_payment_refunded', 'payment_event_id', v_pe.id, 'order_id', v_order.id),
      '결제완료 상태가 아닌 신청 건에 환불 이벤트가 들어옴(상태 반영 안 함) — order_id='
        || v_order.id::text
        || ', payment_status=' || coalesce(v_order.payment_status, 'null')
        || ', payment_event_id=' || v_pe.id::text
    );
    return;
  end if;

  v_new_total := v_order.refunded_amount + coalesce(v_pe.amount, 0);

  if v_pe.currency is distinct from 'KRW'
     or v_pe.amount is null or v_pe.amount <= 0
     or v_order.final_amount is null
     or v_new_total > v_order.final_amount then
    insert into public.dead_letters (source, payload, error_message)
    values (
      v_pe.provider,
      jsonb_build_object('handler', 'on_payment_refunded', 'payment_event_id', v_pe.id, 'order_id', v_order.id),
      '환불 금액을 반영할 수 없음(통화 불일치·0 이하·환불 누적 금액 초과 — 상태 반영 안 함, 대사 확인 필요) — order_id='
        || v_order.id::text
        || ', 결제액=' || coalesce(v_order.final_amount::text, 'null')
        || ', 기존 환불 누적=' || v_order.refunded_amount::text
        || ', 이번 환불=' || coalesce(v_pe.amount::text, 'null')
        || ', currency=' || coalesce(v_pe.currency, 'null')
        || ', payment_event_id=' || v_pe.id::text
    );
    return;
  end if;

  -- 부분 환불: 금액만 누적. 수강 상태·좌석·이용권은 그대로. order_events는 쓰지 않는다(결제
  -- 이력은 payment_events에만 — 2026-09-23 D3 결정). 반응할 모듈이 없어 outbox 사실도 없다.
  if v_new_total < v_order.final_amount then
    update public.orders
    set refunded_amount = v_new_total,
        refunded_event_ids = refunded_event_ids || v_pe.id,
        payment_status = 'PARTIALLY_REFUNDED'
    where id = v_order.id;
    return;
  end if;

  -- 전액 환불(누적 = 결제액): 환불 = 수강 종료. 기존 동작 그대로.
  update public.orders
  set payment_status = 'REFUNDED',
      refunded_at = now(),
      refunded_amount = v_new_total,
      refunded_event_ids = refunded_event_ids || v_pe.id,
      status = 'CANCELLED',
      cancelled_at = coalesce(cancelled_at, now())
  where id = v_order.id;

  -- 이미 취소·반려된 주문이 아니었으면 취소 이력을 남기고 좌석을 돌려준다(옛 함수와 같은 조건).
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
    jsonb_build_object('order_id', v_order.id, 'user_id', v_order.user_id, 'payment_event_id', v_pe.id)
  );
end;
$$;
