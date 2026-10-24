-- 개설강의마다 신청 즉시 승인 여부.
-- transition_order는 p_actor_role이 ADMIN|MANAGER만 허용하므로 자동승인은 create_order
-- 안에서 APPROVED 분기를 인라인한다(transition_order APPROVED와 1:1 — status·approved_at·
-- order_events. 현재 transition_order에 동결/미인증 가드는 없음 → 인라인에도 넣지 않음).

alter table public.course_offerings
  add column if not exists auto_approve boolean not null default false;

comment on column public.course_offerings.auto_approve is
  'true면 create_order 성공 시 같은 트랜잭션에서 APPROVED까지 전이';

-- =====================================================================
-- create_order — 20260923190000 본문 + 자동승인 인라인
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
      and (ends_at is null or now() <= ends_at);

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
-- create_course_offering — p_auto_approve 추가(기본 false, 기존 13인자 호출 호환)
-- =====================================================================
drop function if exists public.create_course_offering(
  uuid, text, integer, integer, text, boolean, timestamptz, timestamptz, text[], jsonb, time, time, smallint[]
);

create function public.create_course_offering(
  p_course_id uuid,
  p_label text,
  p_capacity integer,
  p_price integer,
  p_location text,
  p_is_one_time boolean,
  p_opens_at timestamptz,
  p_ends_at timestamptz,
  p_required_terms_types text[],
  p_grants jsonb,
  p_session_start_time time,
  p_session_end_time time,
  p_days_of_week smallint[],
  p_auto_approve boolean default false
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_offering_id uuid;
  v_valid_from date;
  v_valid_until date;
  v_days smallint[];
begin
  insert into public.course_offerings (
    course_id, label, capacity, remaining_seats, price, location, is_one_time,
    opens_at, ends_at, required_terms_types, grants, auto_approve
  ) values (
    p_course_id, p_label, p_capacity, p_capacity, p_price, p_location, p_is_one_time,
    p_opens_at, p_ends_at, p_required_terms_types, p_grants, coalesce(p_auto_approve, false)
  )
  returning id into v_offering_id;

  if p_session_start_time is not null and p_session_end_time is not null then
    v_valid_from := p_opens_at::date;
    v_valid_until := coalesce(p_ends_at::date, p_opens_at::date);
    v_days := case
      when p_is_one_time then array[extract(dow from p_opens_at)::smallint]
      else p_days_of_week
    end;

    if v_days is not null and array_length(v_days, 1) > 0 then
      insert into public.course_sessions (
        course_offering_id, day_of_week, start_time, end_time, valid_from, valid_until
      )
      select v_offering_id, d, p_session_start_time, p_session_end_time, v_valid_from, v_valid_until
      from unnest(v_days) as d;
    end if;
  end if;

  return v_offering_id;
end;
$$;
