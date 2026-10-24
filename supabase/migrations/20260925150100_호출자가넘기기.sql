-- transition_order()가 users.role(회원 모듈)을 읽지 않도록
-- 호출자가 p_actor_role을 넘기고, lib/terms.ts가 course_offerings/products(주문 모듈)를
-- 직접 읽지 않도록 호출자가 required_terms_types 배열을 넘긴다(TS 변경은 앱 코드).

create or replace function public.transition_order(
  p_order_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_event_type text,
  p_next_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed_from text[];
  v_order record;
begin
  v_allowed_from := case p_next_status
    when 'APPROVED'  then array['PENDING']
    when 'REJECTED'  then array['PENDING']
    when 'CANCELLED' then array['PENDING', 'APPROVED']
    else null
  end;

  if v_allowed_from is null then
    raise exception '허용되지 않은 전이 대상 상태입니다: %', p_next_status;
  end if;

  -- 위 "목표" 절의 부수 해소 — 조용히 'MANAGER'로 잘못 기록되던 것을 막는다. 호출자가 넘긴 값이
  -- 두 값 중 하나가 아니면 즉시 예외로 멈춘다(조용한 오기록보다 명시적 실패가 낫다).
  if p_actor_role not in ('ADMIN', 'MANAGER') then
    raise exception '알 수 없는 행위자 역할입니다: %', p_actor_role;
  end if;

  select id, user_id, course_offering_id, status, payment_status
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if v_order.id is null then
    raise exception '신청 내역을 찾을 수 없습니다.';
  end if;

  if not (v_order.status = any (v_allowed_from)) then
    raise exception '이미 처리된 신청입니다(현재 상태: %). 화면을 새로고침한 뒤 다시 확인해 주세요.',
      v_order.status
      using errcode = 'restrict_violation';
  end if;

  if p_next_status = 'CANCELLED' and v_order.payment_status <> 'UNPAID' then
    raise exception '이미 결제된 건은 취소가 아니라 환불로 처리해야 합니다.';
  end if;

  update public.orders
  set status = p_next_status,
      approved_at = case when p_next_status = 'APPROVED' then now() else approved_at end,
      cancelled_at = case when p_next_status = 'CANCELLED' then now() else cancelled_at end
  where id = p_order_id
    and status = any (v_allowed_from);

  if not found then
    raise exception '이미 처리된 신청입니다. 화면을 새로고침한 뒤 다시 확인해 주세요.'
      using errcode = 'restrict_violation';
  end if;

  -- users.role을 여기서 읽지 않는다. 호출자(runCommand의 actor.role)가
  -- 이미 알고 있는 값을 그대로 넘긴다. 위에서 이미 'ADMIN'/'MANAGER' 중 하나임을 검증했다.
  insert into public.order_events (event_type, actor, actor_user_id, order_id)
  values (
    p_event_type,
    case when p_actor_role = 'ADMIN' then 'ADMIN' else 'MANAGER' end,
    p_actor_id,
    p_order_id
  );

  if p_next_status in ('REJECTED', 'CANCELLED') and v_order.course_offering_id is not null then
    perform public.release_course_offering_seat(v_order.course_offering_id);
  end if;
end;
$$;

revoke execute on function public.transition_order(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.transition_order(uuid, uuid, text, text, text)
  to service_role;

drop function if exists public.transition_order(uuid, uuid, text, text);
