-- 이중 결제 DLQ 문구를 상태에 무관하게 고친다.
-- 예전 문구는 「이미 결제완료(PAID)된 …」 고정이라 결제 면제(WAIVED) 주문에는 부정확했다(동작은 같았다). 본문은 20261007 이후 정본과 같고
-- 이 한 문구(와 payment_status 표시)만 바뀐다. 시그니처가 같아 실행 권한은 그대로 유지된다.
CREATE OR REPLACE FUNCTION public.on_payment_succeeded(p_payment_event_id uuid, p_order_id uuid, p_provider text, p_amount integer, p_currency text, p_payment_method text, p_metadata jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      '결제 대기(UNPAID)가 아닌 신청 건에 결제성공 이벤트가 들어옴(이중결제 의심 — 이미 결제완료(PAID)·결제 면제(WAIVED) 등) — order_id='
        || v_order.id::text || ', payment_status=' || coalesce(v_order.payment_status, 'null')
        || ', payment_event_id=' || p_payment_event_id::text
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
$function$;
