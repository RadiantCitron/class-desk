-- create_order RPC 복원 및 멱등성 보장:
--
--   orders에 품목·금액 없이 insert(orders_item_exactly_one 위반), 없는 테이블 order_items,
--   없는 컬럼 order_events.status, CHECK에 없는 event_type 'CREATED'. 그 결과 모든 신청·구매가
--   실패했다(임시 DB 실측). 함께 빠졌던 것: 중복 신청 시 좌석 반환(unique_violation 처리),
--   자동승인 not found 검사.
--
-- 복원 기준: 20260930120000_course_offerings_cancelling.sql 5절 본문을 글자 그대로 옮겼다.
-- 10-06의 "약관 ID가 최신 활성 약관인지 DB 재검증"은 넣지 않는다:
--   약관 ID는 사용자가 보내는 값이 아니라 서버가 DB의 현재 약관에서 계산하고
--   (app/student/apply/[offeringId]/actions.ts, getRequiredTermsForOffering), 이 함수는
--   service_role 전용이라 막을 공격이 없으며, 주문 모듈 함수가 회원 모듈 terms를 읽는
--   R1 위반만 만든다. 10-06의 다른 변경(complete_signup 강화, terms.change_summary)은 유지.
-- 10-06 파일은 고치지 않는다(전진 수정).

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
