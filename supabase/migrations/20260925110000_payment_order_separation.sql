-- (위반 V1·V2·V3·V10) — "주문과 결제는 남남".
-- ① record_payment_event()(결제 모듈)는 결제 원장(payment_events) INSERT + 결제의 과거형 사실
--    (PAYMENT_SUCCEEDED / PAYMENT_REFUNDED) 적재만 한다. orders는 읽지도 쓰지도 않는다.
-- ② "이 결제를 받아도 되는 주문인가"(금액·상태) 판단과 주문 테이블 반영은 주문 모듈의 핸들러
--    on_payment_succeeded() / on_payment_refunded()가 한다. 아웃박스 러너가 연동표
--    (lib/wiring/outbox.ts)를 보고 RPC로 부른다.
-- ③ 주문 모듈은 반영한 뒤 자기 사실(ORDER_PAID / ORDER_REFUNDED)을 남기고, 이용권 모듈이 반응한다.

-- =====================================================================
-- 0. 안전장치 — 옛 명령형 토픽의 미처리 메시지가 남아 있으면 중단한다. 이 마이그레이션 뒤로는
--    그 토픽을 받아 줄 연동표 줄이 없어지므로, 남아 있으면 영영 처리되지 않는다(조용히 버리지
--    않는다 — 20260923210000의 TALLY 안전장치와 같은 방식).
-- =====================================================================
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.outbox_messages
  where processed_at is null
    and topic in ('GRANT_ENTITLEMENTS', 'REVOKE_ENTITLEMENTS', 'SEND_EMAIL');
  if v_count > 0 then
    raise exception '처리되지 않은 옛 토픽(GRANT_ENTITLEMENTS/REVOKE_ENTITLEMENTS/SEND_EMAIL) 메시지가 %건 있습니다 — 마이그레이션을 중단합니다. 먼저 러너로 처리하세요.', v_count;
  end if;
end $$;

-- =====================================================================
-- 1. 토픽 CHECK — 사실형 5개만 새로 적재할 수 있다. 옛 명령형 3개는 이미 처리된 과거 행으로만
-- 남는다(삭제 없음 — 행은 보존하되, 새로 넣으면 DB가 거부한다).
-- =====================================================================
alter table public.outbox_messages drop constraint outbox_messages_topic_check;
alter table public.outbox_messages
  add constraint outbox_messages_topic_check
    check (
      topic in ('PAYMENT_SUCCEEDED', 'PAYMENT_REFUNDED', 'ORDER_PAID', 'ORDER_REFUNDED', 'USER_WITHDRAWN')
      or (topic in ('GRANT_ENTITLEMENTS', 'REVOKE_ENTITLEMENTS', 'SEND_EMAIL') and processed_at is not null)
    );

-- =====================================================================
-- 2. record_payment_event() — 원장 + 사실만. 매개변수 구성은 그대로라 create or replace로 충분하고
--    기존 실행 권한(service_role만)도 그대로 유지된다.
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

  -- 결제의 과거형 사실만 남긴다. 누가 반응하는지는 모른다(연동표가 안다).
  -- PAYMENT_INITIATED·PAYMENT_FAILED는 반응하는 모듈이 없어 원장에만 남긴다.
  if p_event_type = 'PAYMENT_SUCCEEDED' then
    insert into public.outbox_messages (topic, payload)
    values ('PAYMENT_SUCCEEDED', jsonb_build_object('payment_event_id', v_event_id, 'order_id', p_order_id));
  elsif p_event_type = 'REFUNDED' then
    insert into public.outbox_messages (topic, payload)
    values ('PAYMENT_REFUNDED', jsonb_build_object('payment_event_id', v_event_id, 'order_id', p_order_id));
  end if;

  return true;
end;
$$;

-- =====================================================================
-- 3. 주문 모듈 핸들러 ① — 결제 성공 사실에 반응. 판단 문구는 옛 record_payment_event()와 같다.
--    러너는 "적어도 한 번" 배달한다(처리 완료 표시 전에 죽으면 같은 메시지가 다시 온다) — 그래서
--    이 결제 이벤트에 대해 이미 결론(ORDER_PAID 적재 또는 DLQ)을 냈으면 아무것도 안 하고 끝낸다.
-- =====================================================================
create function public.on_payment_succeeded(p_payment_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pe record;
  v_order record;
  v_grants jsonb;
begin
  select id, provider, order_id, amount, payment_method, metadata
    into v_pe
  from public.payment_events
  where id = p_payment_event_id;

  if v_pe.id is null then
    raise exception '결제 이벤트를 찾을 수 없습니다: %', p_payment_event_id;
  end if;

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

  select id, user_id, status, payment_status, final_amount, course_offering_id, product_id
    into v_order
  from public.orders
  where id = v_pe.order_id
  for update;

  if v_order.final_amount is null or v_pe.amount is distinct from v_order.final_amount then
    insert into public.dead_letters (source, payload, error_message)
    values (
      v_pe.provider,
      jsonb_build_object('handler', 'on_payment_succeeded', 'payment_event_id', v_pe.id, 'order_id', v_order.id),
      '결제 금액이 청구 금액과 다름(상태 반영 안 함, 대사·환불 확인 필요) — order_id='
        || v_order.id::text
        || ', 청구=' || coalesce(v_order.final_amount::text, 'null')
        || ', 수신=' || coalesce(v_pe.amount::text, 'null')
        || ', payment_event_id=' || v_pe.id::text
    );
    return;
  end if;

  if v_order.payment_status is distinct from 'UNPAID' then
    insert into public.dead_letters (source, payload, error_message)
    values (
      v_pe.provider,
      jsonb_build_object('handler', 'on_payment_succeeded', 'payment_event_id', v_pe.id, 'order_id', v_order.id),
      '이미 결제완료(PAID)된 신청 건에 결제성공 이벤트가 다시 들어옴(이중결제 의심) — order_id='
        || v_order.id::text || ', payment_event_id=' || v_pe.id::text
    );
    return;
  end if;

  if v_order.status is distinct from 'APPROVED' then
    insert into public.dead_letters (source, payload, error_message)
    values (
      v_pe.provider,
      jsonb_build_object('handler', 'on_payment_succeeded', 'payment_event_id', v_pe.id, 'order_id', v_order.id),
      '주문 상태가 APPROVED가 아닌 건에 결제성공 이벤트가 들어옴(결제 진행 중 취소·반려 의심, 환불 검토 필요) — order_id='
        || v_order.id::text
        || ', status=' || coalesce(v_order.status, 'null')
        || ', payment_event_id=' || v_pe.id::text
    );
    return;
  end if;

  update public.orders
  set payment_status = 'PAID', paid_at = now(), payment_method = v_pe.payment_method
  where id = v_order.id
    and payment_status = 'UNPAID'
    and status = 'APPROVED';

  -- 구매 당시 부여할 이용권 목록을 스냅샷으로 사실에 싣는다 — 이용권 모듈이 카탈로그
  -- (course_offerings/products)를 읽지 않게. 우선순위는 옛 grantEntitlements와
  -- 같다: 결제 메타데이터의 grants → 강의 grants → 상품 grants. 비어 있을 때의 기본값
  -- (COURSE_ACCESS)은 이용권 모듈이 정한다.
  v_grants := coalesce(
    v_pe.metadata->'grants',
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
      'payment_event_id', v_pe.id,
      'grants', v_grants
    )
  );
end;
$$;

revoke execute on function public.on_payment_succeeded(uuid)
  from public, anon, authenticated;
grant execute on function public.on_payment_succeeded(uuid)
  to service_role;

-- =====================================================================
-- 4. 주문 모듈 핸들러 ② — 환불 사실에 반응. 환불 = 수강 종료.
--    transition_order()의 "이미 결제된 건은 취소가 아니라 환불로" 가드는 건드리지 않는다 —
-- 이 함수가 "환불로 인한 취소"라는 별개의 경로다(가드 충돌 해법).
-- =====================================================================
create function public.on_payment_refunded(p_payment_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pe record;
  v_order record;
begin
  select id, provider, order_id
    into v_pe
  from public.payment_events
  where id = p_payment_event_id;

  if v_pe.id is null then
    raise exception '결제 이벤트를 찾을 수 없습니다: %', p_payment_event_id;
  end if;

  if exists (
       select 1 from public.outbox_messages
       where topic = 'ORDER_REFUNDED' and payload->>'payment_event_id' = p_payment_event_id::text
     )
     or exists (
       select 1 from public.dead_letters
       where payload->>'handler' = 'on_payment_refunded'
         and payload->>'payment_event_id' = p_payment_event_id::text
     ) then
    return;
  end if;

  select id, user_id, status, payment_status, course_offering_id
    into v_order
  from public.orders
  where id = v_pe.order_id
  for update;

  if v_order.payment_status is distinct from 'PAID' then
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

  update public.orders
  set payment_status = 'REFUNDED',
      refunded_at = now(),
      status = 'CANCELLED',
      cancelled_at = coalesce(cancelled_at, now())
  where id = v_order.id
    and payment_status = 'PAID';

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

revoke execute on function public.on_payment_refunded(uuid)
  from public, anon, authenticated;
grant execute on function public.on_payment_refunded(uuid)
  to service_role;
