-- 폐강 시 결제완료 건 outbox 적재 + D19(0원 종료).
-- cancel_course_offering을 create or replace로 갱신(Code-A 본문 + outbox/D19).
-- 토픽 ORDER_OFFERING_CANCELLED를 outbox CHECK에 추가.

-- =====================================================================
-- 1. outbox topic CHECK
-- =====================================================================
alter table public.outbox_messages
  drop constraint if exists outbox_messages_topic_check;

alter table public.outbox_messages
  add constraint outbox_messages_topic_check
  check (
    topic in (
      'PAYMENT_SUCCEEDED',
      'PAYMENT_REFUNDED',
      'ORDER_PAID',
      'ORDER_REFUNDED',
      'USER_WITHDRAWN',
      'ORDER_OFFERING_CANCELLED'
    )
    or (
      topic in (
        'GRANT_ENTITLEMENTS',
        'REVOKE_ENTITLEMENTS',
        'SEND_EMAIL',
        'DISCORD_LINKED'
      )
      and processed_at is not null
    )
  );

-- =====================================================================
-- 2. cancel_course_offering — outbox 적재 + D19
-- =====================================================================
create or replace function public.cancel_course_offering(
  p_offering_id uuid,
  p_reason text,
  p_actor uuid
)
returns table(order_id uuid, user_id uuid, action text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
  v_order record;
  v_refundable integer;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '폐강 사유를 입력해야 합니다.';
  end if;

  select status into v_current
  from public.course_offerings
  where id = p_offering_id
  for update;

  if v_current is null then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_current <> 'OPEN' then
    raise exception '모집 중(OPEN)인 개설강의만 폐강할 수 있습니다.';
  end if;

  update public.course_offerings
  set status = 'CANCELLING',
      status_reason = p_reason,
      status_changed_by = p_actor,
      status_changed_at = clock_timestamp()
  where id = p_offering_id;

  -- 결제 전(UNPAID) 신청서 정리
  for v_order in (
    select o.id, o.user_id, o.status, o.payment_status, o.course_offering_id
    from public.orders o
    where o.course_offering_id = p_offering_id
      and o.payment_status = 'UNPAID'
    for update of o
  ) loop
    if v_order.status = 'PENDING' then
      update public.orders
      set status = 'REJECTED'
      where id = v_order.id;

      insert into public.order_events (event_type, actor, order_id)
      values ('REJECTED', 'SYSTEM', v_order.id);

      if v_order.course_offering_id is not null then
        perform public.release_course_offering_seat(v_order.course_offering_id);
      end if;

      order_id := v_order.id;
      user_id := v_order.user_id;
      action := 'REJECTED';
      return next;
    elsif v_order.status = 'APPROVED' then
      update public.orders
      set status = 'CANCELLED',
          cancelled_at = now()
      where id = v_order.id;

      insert into public.order_events (event_type, actor, order_id)
      values ('CANCELLED', 'SYSTEM', v_order.id);

      if v_order.course_offering_id is not null then
        perform public.release_course_offering_seat(v_order.course_offering_id);
      end if;

      order_id := v_order.id;
      user_id := v_order.user_id;
      action := 'CANCELLED';
      return next;
    end if;
  end loop;

  -- 결제 완료 건: D19(0원) 즉시 종료 또는 PG 환불용 outbox
  for v_order in (
    select o.id, o.user_id, o.course_offering_id,
           coalesce(o.final_amount, 0) as final_amount,
           coalesce(o.refunded_amount, 0) as refunded_amount
    from public.orders o
    where o.course_offering_id = p_offering_id
      and o.payment_status in ('PAID', 'PARTIALLY_REFUNDED')
    for update of o
  ) loop
    v_refundable := v_order.final_amount - v_order.refunded_amount;
    if v_refundable < 0 then
      v_refundable := 0;
    end if;

    if v_refundable = 0 then
      -- PG outbox 없이 같은 트랜잭션에서 종료
      update public.orders
      set status = 'CANCELLED',
          cancelled_at = coalesce(cancelled_at, now()),
          payment_status = 'REFUNDED',
          refunded_at = now()
          -- refunded_amount는 0 유지
      where id = v_order.id;

      insert into public.order_events (event_type, actor, order_id)
      values ('CANCELLED', 'SYSTEM', v_order.id);

      if v_order.course_offering_id is not null then
        perform public.release_course_offering_seat(v_order.course_offering_id);
      end if;

      insert into public.outbox_messages (topic, payload)
      values (
        'ORDER_REFUNDED',
        jsonb_build_object(
          'order_id', v_order.id,
          'user_id', v_order.user_id,
          'payment_event_id', null,
          'reason', 'OFFERING_CANCELLED_ZERO_AMOUNT'
        )
      );

      order_id := v_order.id;
      user_id := v_order.user_id;
      action := 'ZERO_CLOSED';
      return next;
    else
      insert into public.outbox_messages (topic, payload)
      values (
        'ORDER_OFFERING_CANCELLED',
        jsonb_build_object(
          'order_id', v_order.id,
          'refundable_amount', v_refundable,
          'reason', p_reason
        )
      );

      order_id := v_order.id;
      user_id := v_order.user_id;
      action := 'REFUND_PENDING';
      return next;
    end if;
  end loop;
end;
$$;

revoke execute on function public.cancel_course_offering(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_course_offering(uuid, text, uuid)
  to service_role;
