-- 직권 수강 부여: 결제 없이 수강권을 주는 길.
--
--  · 결제 상태 WAIVED(결제 면제): 돈이 움직이지 않은 상태. 원장(payment_events)에는 아무것도 쓰지 않는다.
--  · 주문 이벤트 ACCESS_GRANTED: 관리자 직권 부여 기록(사유는 payload.reason).
--  · 아웃박스 사실 ORDER_ACCESS_GRANTED: 주문 모듈의 과거형 사실 → 이용권 모듈이 E-1의 입구
--    grant_entitlements_for_order(p_source = 'ADMIN_GRANT')로 반응한다(R2).
--  · 주문 모듈 DB 함수 grant_order_access(): 위 셋을 한 트랜잭션으로 묶는다(transition_order와 같은 모양).

-- 1. 결제 상태에 WAIVED — 돈이 움직이지 않으므로 UNPAID와 같은 모양의 제약(paid_at·payment_method·refunded_at 모두 null)
alter table public.orders drop constraint orders_payment_status_check;
alter table public.orders
  add constraint orders_payment_status_check
    check (payment_status = any (array['UNPAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'WAIVED']));

alter table public.orders drop constraint orders_payment_consistency;
alter table public.orders
  add constraint orders_payment_consistency check (
    case payment_status
      when 'UNPAID' then paid_at is null and payment_method is null and refunded_at is null
      when 'WAIVED' then paid_at is null and payment_method is null and refunded_at is null
      when 'PAID' then paid_at is not null and payment_method is not null and refunded_at is null
      when 'PARTIALLY_REFUNDED' then paid_at is not null and payment_method is not null and refunded_at is null
      when 'REFUNDED' then paid_at is not null and payment_method is not null and refunded_at is not null and refunded_at >= paid_at
      else false
    end
  );

-- 2. 주문 이벤트 종류에 ACCESS_GRANTED
alter table public.order_events drop constraint order_events_event_type_check;
alter table public.order_events
  add constraint order_events_event_type_check
    check (event_type = any (array['APPLIED', 'APPROVED', 'REJECTED', 'CANCELLED', 'ACCESS_GRANTED']));

-- 3. 아웃박스 사실 토픽에 ORDER_ACCESS_GRANTED (나머지는 20260930140000 이후 그대로)
alter table public.outbox_messages drop constraint outbox_messages_topic_check;
alter table public.outbox_messages
  add constraint outbox_messages_topic_check
    check (
      topic in (
        'PAYMENT_SUCCEEDED', 'PAYMENT_REFUNDED', 'ORDER_PAID', 'ORDER_REFUNDED', 'USER_WITHDRAWN',
        'ORDER_OFFERING_CANCELLED', 'ORDER_ACCESS_GRANTED'
      )
      or (topic in ('GRANT_ENTITLEMENTS', 'REVOKE_ENTITLEMENTS', 'SEND_EMAIL', 'DISCORD_LINKED') and processed_at is not null)
    );

-- 4. grant_order_access() — 승인된 미결제 신청서에 결제 없이 수강권을 준다.
--    행위자 역할은 호출자(runCommand의 actor.role)가 넘긴다 — transition_order와 같다(users.role을 읽지 않는다).
--    ADMIN만 허용한다(무료 수강권 발급은 수동 결제 확정처럼 매니저에게 위임하지 않는다).
--    반환: 남긴 order_events.id (= 이용권의 부여 근거 grant_event_id).
create function public.grant_order_access(
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
  v_order record;
  v_offering_status text;
  v_grants jsonb;
  v_event_id uuid;
begin
  if p_actor_role is distinct from 'ADMIN' then
    raise exception '직권 수강 부여는 관리자만 할 수 있습니다.';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception '직권 부여 사유를 입력해 주세요.';
  end if;

  select id, user_id, status, payment_status, course_offering_id, product_id
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if v_order.id is null then
    raise exception '신청 내역을 찾을 수 없습니다.';
  end if;

  if v_order.status is distinct from 'APPROVED' or v_order.payment_status is distinct from 'UNPAID' then
    raise exception '승인된 미결제 신청 건만 직권 부여할 수 있습니다(현재: 수강 상태 %, 결제 상태 %). 화면을 새로고침한 뒤 다시 확인해 주세요.',
      v_order.status, v_order.payment_status
      using errcode = 'restrict_violation';
  end if;

  if v_order.course_offering_id is not null then
    select status into v_offering_status
    from public.course_offerings
    where id = v_order.course_offering_id;
    if v_offering_status in ('CANCELLING', 'CANCELLED') then
      raise exception '폐강 진행·완료된 개설강의의 신청 건에는 직권 부여할 수 없습니다.';
    end if;
  end if;

  update public.orders
  set payment_status = 'WAIVED'
  where id = v_order.id
    and payment_status = 'UNPAID'
    and status = 'APPROVED';

  insert into public.order_events (event_type, actor, actor_user_id, order_id, payload)
  values ('ACCESS_GRANTED', 'ADMIN', p_actor_id, v_order.id, jsonb_build_object('reason', btrim(p_reason)))
  returning id into v_event_id;

  -- 구매 당시 부여할 이용권 목록을 스냅샷으로 사실에 싣는다 — on_payment_succeeded와 같은 규칙
  -- (이용권 모듈이 카탈로그를 읽지 않게. course_offerings/products는 주문 모듈 소유라 이 읽기는 위반이 아니다).
  v_grants := coalesce(
    (select grants from public.course_offerings where id = v_order.course_offering_id),
    (select grants from public.products where id = v_order.product_id),
    '[]'::jsonb
  );

  insert into public.outbox_messages (topic, payload)
  values (
    'ORDER_ACCESS_GRANTED',
    jsonb_build_object(
      'order_id', v_order.id,
      'user_id', v_order.user_id,
      'grant_event_id', v_event_id,
      'grants', v_grants
    )
  );

  return v_event_id;
end;
$$;

revoke execute on function public.grant_order_access(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.grant_order_access(uuid, uuid, text, text)
  to service_role;
