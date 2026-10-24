-- 환불 정책 버전을 주문에 고정한다.
--
--  · orders.refund_policy_version: 주문을 만든 시점의 환불 정책 버전 id(코드 쪽 레지스트리 lib/shared/refund-policy.ts의 키). 수업 주문에만 값이 있고
--    물품 주문·이 컬럼이 생기기 전의 주문은 null이다(null이면 평가 때 레거시 버전으로 보고 화면에 밝힌다). 소급하지 않는다.
--  · create_order: p_refund_policy_version text default null을 5번째 인자로 더한다. 4인자 함수는 지우고 5인자로 교체(옛 호출은 기본값 null로 그대로 동작).
--    값이 있으면 비어 있지 않고 40자 이하여야 한다. 그 밖의 동작은 20261007100000과 같다.
--  새 시그니처 grant는 같은 파일에.

alter table public.orders add column refund_policy_version text;

drop function public.create_order(uuid, uuid, uuid, uuid[]);

CREATE OR REPLACE FUNCTION public.create_order(p_user_id uuid, p_course_offering_id uuid, p_product_id uuid, p_terms_ids uuid[], p_refund_policy_version text DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- 환불 정책 버전(ADR-0025): 수업 주문에만 고정한다. 값이 있으면 비어 있지 않고 40자 이하여야 한다.
  if p_refund_policy_version is not null and (btrim(p_refund_policy_version) = '' or char_length(p_refund_policy_version) > 40) then
    raise exception '환불 정책 버전이 올바르지 않습니다.';
  end if;

  if p_course_offering_id is not null then
    select id, price into v_offering
    from public.course_offerings
    where id = p_course_offering_id
      and status = 'OPEN'
      and deleted_at is null
      and now() >= recruit_opens_at
      and now() < opens_at
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
    insert into public.orders (user_id, course_offering_id, product_id, list_price, final_amount, refund_policy_version)
    values (p_user_id, p_course_offering_id, p_product_id, v_price, v_price,
            case when p_course_offering_id is not null then p_refund_policy_version else null end)
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
$function$;

revoke execute on function public.create_order(uuid, uuid, uuid, uuid[], text) from public, anon, authenticated;
grant execute on function public.create_order(uuid, uuid, uuid, uuid[], text) to service_role;
