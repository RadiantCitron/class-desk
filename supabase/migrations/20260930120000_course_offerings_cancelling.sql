-- 개설강의 폐강 상태(CANCELLING/CANCELLED), 폐강 시작·마무리 RPC,
-- create_order 개설 조회 FOR SHARE(D16). outbox 적재·0원 즉시 종료(D19)는 Code-D.

-- =====================================================================
-- 1. CHECK: OPEN|CLOSED|CANCELLING|CANCELLED
-- =====================================================================
alter table public.course_offerings
  drop constraint if exists course_offerings_status_check;

alter table public.course_offerings
  add constraint course_offerings_status_check
  check (status in ('OPEN', 'CLOSED', 'CANCELLING', 'CANCELLED'));

-- =====================================================================
-- 2. set_course_offering_status — OPEN↔CLOSED 전용 유지
--    CANCELLING/CANCELLED에서는 마감·재개 불가. 폐강 상태를 목표로 받는 것도 불가.
-- =====================================================================
create or replace function public.set_course_offering_status(
  p_offering_id uuid,
  p_next_status text,
  p_reason text,
  p_actor uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_current text;
begin
  if p_next_status not in ('OPEN', 'CLOSED') then
    raise exception '알 수 없는 상태입니다: %', p_next_status;
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '% 사유를 입력해야 합니다.', case when p_next_status = 'CLOSED' then '마감' else '재개' end;
  end if;

  select status into v_current from public.course_offerings where id = p_offering_id for update;
  if v_current is null then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_current in ('CANCELLING', 'CANCELLED') then
    raise exception '폐강 중이거나 폐강 완료된 개설강의는 마감·재개할 수 없습니다.';
  end if;
  if v_current = p_next_status then
    raise exception '이미 % 상태입니다.', case when p_next_status = 'CLOSED' then '마감' else '재개' end;
  end if;

  update public.course_offerings
  set status = p_next_status,
      status_reason = p_reason,
      status_changed_by = p_actor,
      status_changed_at = clock_timestamp()
  where id = p_offering_id;
end;
$$;

-- =====================================================================
-- 3. cancel_course_offering — OPEN에서만 폐강 시작(단일 트랜잭션)
--    Code-A: 결제 전 신청서 정리 + 결제 완료 건은 상태 불변(REFUND_PENDING 반환만).
--    outbox INSERT·ZERO_CLOSED는 Code-D.
-- =====================================================================
create function public.cancel_course_offering(
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
    raise exception '모집 중(OPEN)인 개설강의만 폐강할 수 있습니다';
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
    -- REJECTED/CANCELLED 등 이미 끝난 UNPAID는 스킵
  end loop;

  -- 결제 완료 건: 상태 불변, 반환만(환불 outbox는 Code-D)
  for v_order in (
    select o.id, o.user_id
    from public.orders o
    where o.course_offering_id = p_offering_id
      and o.payment_status in ('PAID', 'PARTIALLY_REFUNDED')
  ) loop
    order_id := v_order.id;
    user_id := v_order.user_id;
    action := 'REFUND_PENDING';
    return next;
  end loop;
end;
$$;

revoke execute on function public.cancel_course_offering(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_course_offering(uuid, text, uuid)
  to service_role;

-- =====================================================================
-- 4. complete_course_offering_cancel — 마무리 확인(D14). outbox 없음.
-- =====================================================================
create function public.complete_course_offering_cancel(
  p_offering_id uuid,
  p_actor uuid
)
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
    and (
      payment_status in ('PAID', 'PARTIALLY_REFUNDED')
      or status in ('PENDING', 'APPROVED')
    );

  if v_remaining > 0 then
    raise exception '남은 %건이 있어 폐강 마무리를 할 수 없습니다.', v_remaining;
  end if;

  update public.course_offerings
  set status = 'CANCELLED',
      status_changed_by = p_actor,
      status_changed_at = clock_timestamp()
  where id = p_offering_id;
end;
$$;

revoke execute on function public.complete_course_offering_cancel(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_course_offering_cancel(uuid, uuid)
  to service_role;

-- =====================================================================
-- 5. create_order — 20260929120000 본문 + 개설 조회 FOR SHARE(D16)
-- =====================================================================
create or replace function public.create_order(
  p_user_id uuid,
  p_course_offering_id uuid,
  p_product_id uuid,
  p_terms_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offering record;
  v_product record;
  v_reserved boolean;
  v_price integer;
  v_order_id uuid;
  v_terms_id uuid;
begin
  if (p_course_offering_id is null) = (p_product_id is null) then
    raise exception '강의 또는 상품 중 정확히 하나를 선택해야 합니다.';
  end if;

  if p_course_offering_id is not null then
    select id, price into v_offering
    from public.course_offerings
    where id = p_course_offering_id
      and status = 'OPEN'
      and deleted_at is null
      and now() >= opens_at
      and (ends_at is null or now() <= ends_at)
    for share;

    if v_offering.id is null then
      raise exception '신청할 수 없는 개설강의입니다.';
    end if;
    v_price := v_offering.price;

    select public.reserve_course_offering_seat(p_course_offering_id) into v_reserved;
    if not coalesce(v_reserved, false) then
      raise exception '정원이 마감되어 신청할 수 없습니다.';
    end if;
  else
    select id, price into v_product
    from public.products
    where id = p_product_id
      and status = 'OPEN'
      and deleted_at is null;

    if v_product.id is null then
      raise exception '구매할 수 없는 상품입니다.';
    end if;
    v_price := v_product.price;
  end if;

  begin
    insert into public.orders (user_id, course_offering_id, product_id, list_price, final_amount)
    values (p_user_id, p_course_offering_id, p_product_id, v_price, v_price)
    returning id into v_order_id;
  exception when unique_violation then
    if p_course_offering_id is not null then
      perform public.release_course_offering_seat(p_course_offering_id);
    end if;
    raise exception '이미 신청(구매)한 내역입니다.';
  end;

  insert into public.order_events (event_type, actor, payload, order_id)
  values ('APPLIED', 'SYSTEM', '{}'::jsonb, v_order_id);

  if p_terms_ids is not null then
    foreach v_terms_id in array p_terms_ids loop
      insert into public.terms_agreements (user_id, terms_id, order_id)
      values (p_user_id, v_terms_id, v_order_id);
    end loop;
  end if;

  -- 자동승인: 개설강의 플래그가 켜져 있으면 같은 트랜잭션에서 APPROVED.
  -- 물품 주문(course_offering_id null)은 스킵. actor는 SYSTEM(사람 관리자 아님).
  -- transition_order APPROVED 분기와 동일: status·approved_at + order_events APPROVED.
  if p_course_offering_id is not null and exists (
    select 1 from public.course_offerings o
    where o.id = p_course_offering_id and o.auto_approve is true
  ) then
    update public.orders
    set status = 'APPROVED',
        approved_at = now()
    where id = v_order_id
      and status = 'PENDING';

    if not found then
      raise exception '자동승인 실패: 주문이 PENDING이 아닙니다.';
    end if;

    insert into public.order_events (event_type, actor, order_id)
    values ('APPROVED', 'SYSTEM', v_order_id);
  end if;

  return v_order_id;
end;
$$;

revoke execute on function public.create_order(uuid, uuid, uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.create_order(uuid, uuid, uuid, uuid[])
  to service_role;

-- =====================================================================
-- 6. delete_course_offering — 메시지에 폐강 경로 유도
-- =====================================================================
create or replace function public.delete_course_offering(
  p_offering_id uuid,
  p_reason text,
  p_actor uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_order_count integer;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '삭제 사유를 입력해야 합니다.';
  end if;

  select count(*) into v_order_count
  from public.orders
  where course_offering_id = p_offering_id;

  if v_order_count > 0 then
    raise exception '삭제 실패(신청 내역이 있으면 삭제할 수 없습니다). 모집 중이면 폐강을 사용하세요.';
  end if;

  update public.course_sessions
  set deactivated_at = now(),
      deactivated_reason = p_reason
  where course_offering_id = p_offering_id
    and deactivated_at is null;

  update public.course_offerings
  set deleted_at = now(),
      deleted_reason = p_reason,
      deleted_by = p_actor
  where id = p_offering_id;
end;
$$;
