-- 폐강 시 환불 없는 종료 사유 코드 및 귀책 표준화
-- 의존: 20261008130000_폐강학생별처리.sql (close_order_without_refund)

-- close_order_without_refund 재작성: p_cause_code text default 'OFFERING_CANCELLED_NO_REFUND' 추가 (5인자)
drop function if exists public.close_order_without_refund(uuid, uuid, text, text);
drop function if exists public.close_order_without_refund(uuid, uuid, text, text, text);

create or replace function public.close_order_without_refund(
  p_order_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_reason text,
  p_cause_code text default 'OFFERING_CANCELLED_NO_REFUND'
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
  v_cause text;
begin
  if p_actor_role is distinct from 'ADMIN' then
    raise exception '환불 없는 수강 종료는 관리자만 할 수 있습니다.';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception '종료 사유를 입력해 주세요.';
  end if;

  v_cause := coalesce(nullif(btrim(p_cause_code), ''), 'OFFERING_CANCELLED_NO_REFUND');

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
    jsonb_build_object(
      'reason', btrim(p_reason),
      'mode', 'NO_REFUND',
      'cause', v_cause,
      'fault', 'OPERATOR',
      'payment_status', v_order.payment_status
    )
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

revoke execute on function public.close_order_without_refund(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.close_order_without_refund(uuid, uuid, text, text, text)
  to service_role;
