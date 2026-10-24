-- 폐강 = 학생별 명시 처리 후 완료.
--
--  · 폐강 시작은 OPEN·CLOSED에서 가능하다(「재개 → 폐강」 단계 없앰). 결제 전 신청만 자동 정리하고,
--    결제 완료·부분 환불·결제 면제 수강생은 **자동으로 환불·종료하지 않는다**(브레이크) — 관리자가 학생별로 처리한다.
-- (·D14·D19의 「전원 자동 환불」·「0원 자동 종료」를 대체한다.)
--  · close_order_without_refund(): 환불 없이 수강만 종료(돈은 그대로). 이용권은 ORDER_CLOSED 사실로 회수(ADMIN_CLOSED).
--  · complete_course_offering_cancel(): 처리 안 된 수강생(승인 대기·승인됨 상태가 남은 주문)이 0명일 때만 완료.
--    결제 원장 쪽(열린 환불 요청·고아 결제)은 주문 모듈이 원장을 읽을 수 없어(R1) 서버 액션이 따로 확인한다.

-- 1. 주문 이벤트 종류에 CLOSED, 아웃박스 사실 토픽에 ORDER_CLOSED.
--    ORDER_OFFERING_CANCELLED는 더 이상 발행하지 않지만 과거 행이 남아 있을 수 있어 허용 목록에는 둔다.
alter table public.order_events drop constraint order_events_event_type_check;
alter table public.order_events
  add constraint order_events_event_type_check
    check (event_type = any (array['APPLIED', 'APPROVED', 'REJECTED', 'CANCELLED', 'ACCESS_GRANTED', 'CLOSED']));

alter table public.outbox_messages drop constraint outbox_messages_topic_check;
alter table public.outbox_messages
  add constraint outbox_messages_topic_check
    check (
      topic in (
        'PAYMENT_SUCCEEDED', 'PAYMENT_REFUNDED', 'ORDER_PAID', 'ORDER_REFUNDED', 'USER_WITHDRAWN',
        'ORDER_OFFERING_CANCELLED', 'ORDER_ACCESS_GRANTED', 'ORDER_CLOSED'
      )
      or (topic in ('GRANT_ENTITLEMENTS', 'REVOKE_ENTITLEMENTS', 'SEND_EMAIL', 'DISCORD_LINKED') and processed_at is not null)
    );

-- 2. 폐강 시작 — 반환 행 (order_id, user_id, action): REJECTED·CANCELLED(결제 전 자동 정리),
--    ACTION_REQUIRED(관리자 처리 대기: 승인됨 + 결제 완료·부분 환불·결제 면제). 안내 메일이 이 구분을 쓴다.
create or replace function public.cancel_course_offering(p_offering_id uuid, p_reason text, p_actor uuid)
returns table (order_id uuid, user_id uuid, action text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
  v_order record;
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
  if v_current not in ('OPEN', 'CLOSED') then
    raise exception '모집 중(OPEN)이거나 마감(CLOSED)인 개설강의만 폐강할 수 있습니다.';
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

  -- 결제 완료·부분 환불·결제 면제 수강생은 자동으로 건드리지 않는다 — 관리자가 학생별로 처리한다(환불 / 환불 없이 종료).
  for v_order in (
    select o.id, o.user_id
    from public.orders o
    where o.course_offering_id = p_offering_id
      and o.status = 'APPROVED'
      and o.payment_status in ('PAID', 'PARTIALLY_REFUNDED', 'WAIVED')
  ) loop
    order_id := v_order.id;
    user_id := v_order.user_id;
    action := 'ACTION_REQUIRED';
    return next;
  end loop;
end;
$$;

-- 3. 환불 없이 수강 종료 — 폐강 중인 개설강의의 승인된 주문 한 건을 관리자가 명시적으로 종료한다.
--    결제 상태·금액은 그대로 둔다(돈은 그대로 — 고객센터 대응). 좌석 반환, 주문 이벤트 CLOSED(사유), 이용권은 사실 ORDER_CLOSED로 회수.
--    행위자 역할은 호출자가 넘긴다(users.role을 읽지 않음, transition_order와 같다). ADMIN만 허용.
create function public.close_order_without_refund(
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
  v_event_id uuid;
begin
  if p_actor_role is distinct from 'ADMIN' then
    raise exception '환불 없는 수강 종료는 관리자만 할 수 있습니다.';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception '종료 사유를 입력해 주세요.';
  end if;

  select id, user_id, status, payment_status, course_offering_id
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if v_order.id is null then
    raise exception '신청 내역을 찾을 수 없습니다.';
  end if;

  if v_order.course_offering_id is not null then
    select status into v_offering_status
    from public.course_offerings
    where id = v_order.course_offering_id;
  end if;
  if v_offering_status is distinct from 'CANCELLING' then
    raise exception '폐강 진행 중(CANCELLING)인 개설강의의 신청 건만 환불 없이 종료할 수 있습니다.';
  end if;

  if v_order.status is distinct from 'APPROVED' then
    raise exception '승인된 신청 건만 종료할 수 있습니다(현재 수강 상태: %). 화면을 새로고침한 뒤 다시 확인해 주세요.', v_order.status
      using errcode = 'restrict_violation';
  end if;

  update public.orders
  set status = 'CANCELLED',
      cancelled_at = now()
  where id = v_order.id
    and status = 'APPROVED';

  insert into public.order_events (event_type, actor, actor_user_id, order_id, payload)
  values (
    'CLOSED', 'ADMIN', p_actor_id, v_order.id,
    jsonb_build_object('reason', btrim(p_reason), 'mode', 'NO_REFUND', 'payment_status', v_order.payment_status)
  )
  returning id into v_event_id;

  perform public.release_course_offering_seat(v_order.course_offering_id);

  insert into public.outbox_messages (topic, payload)
  values (
    'ORDER_CLOSED',
    jsonb_build_object('order_id', v_order.id, 'user_id', v_order.user_id, 'close_event_id', v_event_id)
  );

  return v_event_id;
end;
$$;

revoke execute on function public.close_order_without_refund(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.close_order_without_refund(uuid, uuid, text, text)
  to service_role;

-- 4. 폐강 완료 — 처리 안 된 수강생(승인 대기·승인됨이 남은 주문)이 있으면 거부한다. 강제 통과 없음.
--    결제 상태는 보지 않는다: 환불 완료는 CANCELLED, 환불 없는 종료도 CANCELLED이므로 수강 상태만으로 「처리됨」이 정해진다.
create or replace function public.complete_course_offering_cancel(p_offering_id uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
  v_remaining integer;
begin
  select status into v_current
  from public.course_offerings
  where id = p_offering_id
  for update;

  if v_current is null then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_current <> 'CANCELLING' then
    raise exception '폐강 중(CANCELLING)인 개설강의만 마무리할 수 있습니다.';
  end if;

  select count(*) into v_remaining
  from public.orders
  where course_offering_id = p_offering_id
    and status in ('PENDING', 'APPROVED');

  if v_remaining > 0 then
    raise exception '남은 %건의 수강생 처리가 끝나지 않아 폐강 마무리를 할 수 없습니다.', v_remaining;
  end if;

  update public.course_offerings
  set status = 'CANCELLED',
      status_changed_by = p_actor,
      status_changed_at = clock_timestamp()
  where id = p_offering_id;
end;
$$;
