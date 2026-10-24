-- =====================================================================
-- 일정 변경 뒤 흐름 단순화 (동의/미동의 응답 체계 해체 -> 고지 + 환불 신청)
-- 1. respond_schedule_change 함수 삭제 (drop)
-- 2. exclude_order_for_schedule_change 함수에서 응답·동의 조건 제거 (미결제·무료 단순 제외만 처리)
-- =====================================================================

-- 1. respond_schedule_change 삭제
drop function if exists public.respond_schedule_change(uuid, uuid, uuid, boolean);

-- 2. exclude_order_for_schedule_change 단순화 (동의/미동의 조건 없이 최신 안내가 있는 미결제/무료 주문 제외)
create or replace function public.exclude_order_for_schedule_change(
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
  v_offering record;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_notice uuid;
  v_notice_change text;
  v_event_id uuid;
  v_first date;
  v_total integer;
  v_past integer;
begin
  if p_actor_id is null or p_actor_role is distinct from 'ADMIN' then
    raise exception '관리자만 일정 변경으로 인한 제외 처리를 할 수 있습니다.';
  end if;
  if v_reason = '' then
    raise exception '제외 사유를 입력해야 합니다.';
  end if;

  select id, user_id, status, payment_status, course_offering_id into v_order
  from public.orders where id = p_order_id for update;
  if not found then
    raise exception '신청 건을 찾을 수 없습니다.';
  end if;
  if v_order.status not in ('PENDING', 'APPROVED') then
    raise exception '이미 종료된 신청 건입니다.';
  end if;
  if v_order.payment_status in ('PAID', 'PARTIALLY_REFUNDED') then
    raise exception '결제가 완료된 신청 건은 환불 경로(선별 일괄 환불 또는 주문 상세 환불)로 처리합니다.';
  end if;

  if v_order.course_offering_id is not null then
    select status, ended_at into v_offering from public.course_offerings where id = v_order.course_offering_id;
    if v_offering.ended_at is not null then
      raise exception '종료된 수업의 신청 건은 일정 변경으로 제외할 수 없습니다.';
    end if;
    if v_offering.status in ('CANCELLING', 'CANCELLED') then
      raise exception '폐강 중인 수업의 신청 건은 일정 변경으로 제외할 수 없습니다. 폐강 처리로 환불하세요.';
    end if;
  end if;

  select e.id, e.payload->>'change_id' into v_notice, v_notice_change
  from public.order_events e
  where e.order_id = p_order_id and e.event_type = 'SCHEDULE_CHANGE_NOTICE'
  order by e.created_at desc, e.id desc
  limit 1;
  if v_notice is null then
    raise exception '일정 변경 안내가 없는 신청 건은 이 방법으로 제외할 수 없습니다.';
  end if;

  if v_order.course_offering_id is not null then
    select s.first_date, s.total_count, s.past_count into v_first, v_total, v_past
    from public.offering_session_stats(v_order.course_offering_id) s;
  end if;

  update public.orders set status = 'CANCELLED', cancelled_at = coalesce(cancelled_at, now()) where id = p_order_id;

  insert into public.order_events (event_type, actor, actor_user_id, order_id, payload)
  values (
    'CANCELLED', 'ADMIN', p_actor_id, p_order_id,
    jsonb_build_object(
      'cause', 'SCHEDULE_CHANGE', 'reason', v_reason, 'mode', 'NO_REFUND',
      'notice_event_id', v_notice, 'change_id', v_notice_change,
      'total_sessions', v_total, 'past_sessions', v_past, 'first_class_date', v_first
    )
  )
  returning id into v_event_id;

  if v_order.course_offering_id is not null then
    perform public.release_course_offering_seat(v_order.course_offering_id);
  end if;

  insert into public.outbox_messages (topic, payload)
  values ('ORDER_CLOSED', jsonb_build_object('order_id', p_order_id, 'user_id', v_order.user_id, 'close_event_id', v_event_id));

  return v_event_id;
end;
$$;

revoke execute on function public.exclude_order_for_schedule_change(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.exclude_order_for_schedule_change(uuid, uuid, text, text) to service_role;
