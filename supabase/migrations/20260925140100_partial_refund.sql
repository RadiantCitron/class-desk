--  — 부분 환불 + 결제 핸들러 멱등 확인 위치 교정.
--
-- (발화 그대로): "부분환불은 부분환불로 처리한다. 주문전체 처리 아니다. 토스페이먼츠나
-- 스텝페이에게 부분환불지원하면 우리도 부분환불처리한다." + 선택: 부분 환불이면 수강 상태·좌석·이용권은
-- 유지하고 금액만 누적한다. 누적액이 결제액과 같아지면 전액 환불(취소·좌석 반환·이용권 회수)이다.
-- PG 중립: 환불 이벤트 1건 = 금액 1건. 토스페이먼츠는 cancelAmount로 여러 번 부분 취소가 되고
-- (cancels 배열), 어느 PG든 어댑터가 "이번에 환불된 금액"으로 매핑하면 된다.
--
-- ① orders: refunded_amount(환불 누적액), refunded_event_ids(반영한 환불 이벤트 — 부분 환불은 outbox
--    사실을 남기지 않아 "이미 처리했나"를 여기로 판정), payment_status에 PARTIALLY_REFUNDED 추가.
-- ② on_payment_succeeded: 멱등 확인을 주문 행 잠금 "뒤"로 옮긴다. 예전엔 잠금 전에 확인해서, 같은 메시지를
--    두 러너가 동시에 처리하면 두 번째가 잠금을 기다린 뒤 PAID를 보고 가짜 "이중결제 의심" DLQ를 남겼다.
--    통화가 KRW가 아니면 반영하지 않고 DLQ.
-- ③ on_payment_refunded: 부분/전액 분기, 초과 환불·통화 불일치 DLQ, 잠금 뒤 멱등 확인.
--
-- PARTIALLY_REFUNDED 주문은 "결제된 주문"이다 — 기존 판정이 전부 `payment_status <> 'UNPAID'`라
-- (자가 취소·관리자 취소·재결제 금지·대사 점검) 코드 변경 없이 그대로 적용된다.

alter table public.orders
  add column refunded_amount integer not null default 0,
  add column refunded_event_ids uuid[] not null default '{}';

alter table public.orders add constraint orders_refunded_amount_nonnegative
  check (refunded_amount >= 0);

alter table public.orders drop constraint orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('UNPAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'));

-- orders_payment_consistency(20260923180000)는 payment_status별 필드 일관성을 검사하는데
-- ELSE false라 새 값(PARTIALLY_REFUNDED)이 자동으로 막힌다 — 새 분기를 추가한다. 부분 환불은
-- PAID처럼 paid_at·payment_method가 있고, refunded_at은 아직 null이다(전액 환불에서만 채운다 —
-- "환불된 시각" = "이 주문이 끝난 시각"이라는 기존 의미를 그대로 유지, refunded_amount가 누적액).
alter table public.orders drop constraint orders_payment_consistency;
alter table public.orders add constraint orders_payment_consistency
  check (
    case payment_status
      when 'UNPAID' then paid_at is null and payment_method is null and refunded_at is null
      when 'PAID' then paid_at is not null and payment_method is not null and refunded_at is null
      when 'PARTIALLY_REFUNDED' then paid_at is not null and payment_method is not null and refunded_at is null
      when 'REFUNDED' then paid_at is not null and payment_method is not null and refunded_at is not null and refunded_at >= paid_at
      else false
    end
  );

-- 이미 전액 환불된 과거 행은 누적액을 결제액으로 채운다(로컬 데이터 정합 — 운영 데이터 없음).
update public.orders
set refunded_amount = coalesce(final_amount, 0)
where payment_status = 'REFUNDED' and refunded_amount = 0;

-- =====================================================================
-- ② on_payment_succeeded — 잠금 → 멱등 → 판정 순서.
-- =====================================================================
create or replace function public.on_payment_succeeded(p_payment_event_id uuid)
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
  select id, provider, order_id, amount, currency, payment_method, metadata
    into v_pe
  from public.payment_events
  where id = p_payment_event_id;

  if v_pe.id is null then
    raise exception '결제 이벤트를 찾을 수 없습니다: %', p_payment_event_id;
  end if;

  -- 주문 행을 먼저 잠근다. 같은 결제 이벤트를 동시에 처리하는 두 번째 호출은 여기서 기다렸다가,
  -- 첫 번째가 남긴 결론(ORDER_PAID 또는 DLQ)을 아래 멱등 확인에서 보고 조용히 끝난다.
  select id, user_id, status, payment_status, final_amount, course_offering_id, product_id
    into v_order
  from public.orders
  where id = v_pe.order_id
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

  if v_pe.currency is distinct from 'KRW' then
    insert into public.dead_letters (source, payload, error_message)
    values (
      v_pe.provider,
      jsonb_build_object('handler', 'on_payment_succeeded', 'payment_event_id', v_pe.id, 'order_id', v_order.id),
      '결제 통화가 KRW가 아님(상태 반영 안 함, 대사·환불 확인 필요) — order_id='
        || v_order.id::text || ', currency=' || coalesce(v_pe.currency, 'null')
        || ', payment_event_id=' || v_pe.id::text
    );
    return;
  end if;

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
  -- (course_offerings/products)를 읽지 않게. 우선순위: 결제 메타데이터의 grants →
  -- 강의 grants → 상품 grants. 비어 있을 때의 기본값(COURSE_ACCESS)은 이용권 모듈이 정한다.
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

-- create or replace는 기존 권한을 유지하지만, 관례대로 다시 명시한다.
revoke execute on function public.on_payment_succeeded(uuid)
  from public, anon, authenticated;
grant execute on function public.on_payment_succeeded(uuid)
  to service_role;

-- =====================================================================
-- ③ on_payment_refunded — 부분 환불 / 전액 환불.
-- =====================================================================
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

revoke execute on function public.on_payment_refunded(uuid)
  from public, anon, authenticated;
grant execute on function public.on_payment_refunded(uuid)
  to service_role;
