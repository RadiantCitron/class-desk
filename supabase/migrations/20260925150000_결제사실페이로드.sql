do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.outbox_messages
  where processed_at is null
    and topic in ('PAYMENT_SUCCEEDED', 'PAYMENT_REFUNDED');
  if v_count > 0 then
    raise exception '미처리 결제 사실 메시지가 %건 있습니다 — 마이그레이션을 중단합니다. 먼저 러너로 전부 처리한 뒤 다시 실행하세요.', v_count;
  end if;
end $$;

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
begin
  -- 주문이 실제로 있는지는 payment_events.order_id 외래키(payment_events_order_id_fkey)가
  -- 확인한다 — 없는 주문이면 아래 INSERT가 실패하고 전체가 롤백된다(integrity TEST11).
  -- 결제 모듈은 orders를 읽지 않는다.
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

  -- 주문 모듈이 payment_events를 직접 읽지 않도록, 그 함수가 필요한 값
  -- (금액·통화·결제수단·제공자·메타데이터)을 사실 메시지에 실어 보낸다.
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
    insert into public.outbox_messages (topic, payload)
    values ('PAYMENT_REFUNDED', jsonb_build_object(
      'payment_event_id', v_event_id,
      'order_id', p_order_id,
      'provider', p_provider,
      'amount', p_amount,
      'currency', p_currency
    ));
  end if;

  return true;
end;
$$;

drop function if exists public.on_payment_succeeded(uuid);

create function public.on_payment_succeeded(
  p_payment_event_id uuid,
  p_order_id uuid,
  p_provider text,
  p_amount integer,
  p_currency text,
  p_payment_method text,
  p_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_grants jsonb;
begin
  -- 주문 행을 먼저 잠근다. 같은 결제 이벤트를 동시에 처리하는 두 번째 호출은 여기서 기다렸다가,
  -- 첫 번째가 남긴 결론(ORDER_PAID 또는 DLQ)을 아래 멱등 확인에서 보고 조용히 끝난다.
  select id, user_id, status, payment_status, final_amount, course_offering_id, product_id
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if exists (
       select 1 from public.outbox_messages
       where topic = 'ORDER_PAID' and payload->>'payment_event_id' = p_payment_event_id::text
     )
     or exists (
       select 1 from public.dead_letters
       where payload->>'handler' = 'on_payment_succeeded'
         and payload->>'payment_event_id' = p_payment_event_id::text
     ) then
    return;
  end if;

  if p_currency is distinct from 'KRW' then
    insert into public.dead_letters (source, payload, error_message)
    values (
      p_provider,
      jsonb_build_object('handler', 'on_payment_succeeded', 'payment_event_id', p_payment_event_id, 'order_id', v_order.id),
      '결제 통화가 KRW가 아님(상태 반영 안 함, 대사·환불 확인 필요) — order_id='
        || v_order.id::text || ', currency=' || coalesce(p_currency, 'null')
        || ', payment_event_id=' || p_payment_event_id::text
    );
    return;
  end if;

  if v_order.final_amount is null or p_amount is distinct from v_order.final_amount then
    insert into public.dead_letters (source, payload, error_message)
    values (
      p_provider,
      jsonb_build_object('handler', 'on_payment_succeeded', 'payment_event_id', p_payment_event_id, 'order_id', v_order.id),
      '결제 금액이 청구 금액과 다름(상태 반영 안 함, 대사·환불 확인 필요) — order_id='
        || v_order.id::text
        || ', 청구=' || coalesce(v_order.final_amount::text, 'null')
        || ', 수신=' || coalesce(p_amount::text, 'null')
        || ', payment_event_id=' || p_payment_event_id::text
    );
    return;
  end if;

  if v_order.payment_status is distinct from 'UNPAID' then
    insert into public.dead_letters (source, payload, error_message)
    values (
      p_provider,
      jsonb_build_object('handler', 'on_payment_succeeded', 'payment_event_id', p_payment_event_id, 'order_id', v_order.id),
      '이미 결제완료(PAID)된 신청 건에 결제성공 이벤트가 다시 들어옴(이중결제 의심) — order_id='
        || v_order.id::text || ', payment_event_id=' || p_payment_event_id::text
    );
    return;
  end if;

  if v_order.status is distinct from 'APPROVED' then
    insert into public.dead_letters (source, payload, error_message)
    values (
      p_provider,
      jsonb_build_object('handler', 'on_payment_succeeded', 'payment_event_id', p_payment_event_id, 'order_id', v_order.id),
      '주문 상태가 APPROVED가 아닌 건에 결제성공 이벤트가 들어옴(결제 진행 중 취소·반려 의심, 환불 검토 필요) — order_id='
        || v_order.id::text
        || ', status=' || coalesce(v_order.status, 'null')
        || ', payment_event_id=' || p_payment_event_id::text
    );
    return;
  end if;

  update public.orders
  set payment_status = 'PAID', paid_at = now(), payment_method = p_payment_method
  where id = v_order.id
    and payment_status = 'UNPAID'
    and status = 'APPROVED';

  -- 구매 당시 부여할 이용권 목록을 스냅샷으로 사실에 싣는다 — 이용권 모듈이 카탈로그를 읽지
  -- 않게. course_offerings/products는 주문 모듈 소유라 이 읽기는 위반이 아니다.
  v_grants := coalesce(
    p_metadata->'grants',
    (select grants from public.course_offerings where id = v_order.course_offering_id),
    (select grants from public.products where id = v_order.product_id),
    '[]'::jsonb
  );

  insert into public.outbox_messages (topic, payload)
  values (
    'ORDER_PAID',
    jsonb_build_object(
      'order_id', v_order.id,
      'user_id', v_order.user_id,
      'payment_event_id', p_payment_event_id,
      'grants', v_grants
    )
  );
end;
$$;

revoke execute on function public.on_payment_succeeded(uuid, uuid, text, integer, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.on_payment_succeeded(uuid, uuid, text, integer, text, text, jsonb)
  to service_role;

drop function if exists public.on_payment_refunded(uuid);

create function public.on_payment_refunded(
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

revoke execute on function public.on_payment_refunded(uuid, uuid, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.on_payment_refunded(uuid, uuid, text, integer, text)
  to service_role;
