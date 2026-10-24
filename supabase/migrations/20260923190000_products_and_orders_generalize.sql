-- DB 구조 재정립 5단계(2026-09-23) — 물품 추가(구조만, 화면은 만들지 않음).
-- 수업과 물품을 orders 하나로 판다는 4단계까지의
-- 구조를 실제로 완성한다: 품목을 course_offerings 또는 products 중 정확히 하나로 가리키게
-- 하고, 결제 이력(payment_events)이 "둘 중 하나" 자리를 신청서(주문) 하나로 정리하면서
-- 필요 없어지는 purpose·user_id를 함께 없앤다.

-- =====================================================================
-- 1. products — course_offerings와 같은 이름·형식의 공통 속성만 담는다. 좌석·일정처럼
--    수업에만 있는 것은 담지 않는다(카탈로그 공통 속성은 같은 이름·형식으로).
-- =====================================================================
create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  price integer not null check (price >= 0),
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  grants jsonb not null default '[]'::jsonb,
  required_terms_types text[] not null default '{}'::text[]
    check (required_terms_types <@ array['THIRD_PARTY_SHARE', 'MARKETING_OPT_IN', 'AI_CROSS_BORDER_TRANSFER', 'SOFTWARE_LICENSE_USE']),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.products enable row level security;

-- course_offerings RLS와 똑같은 원칙: 로그인한 사람은 조회, 관리자만 등록/수정/삭제.
create policy "로그인한 사용자는 상품 조회 가능"
  on public.products for select
  using (auth.role() = 'authenticated');

create policy "관리자만 상품 등록/수정/삭제 가능"
  on public.products for all
  using (is_admin());

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

-- =====================================================================
-- 2. orders — course_offering_id를 nullable로 바꾸고 product_id를 더해, "수업 또는 물품 중
--    정확히 하나"만 가리키게 한다(안티패턴인 다형 참조 대신 실제 FK 두 개 + CHECK).
-- =====================================================================
alter table public.orders alter column course_offering_id drop not null;

alter table public.orders
  add column product_id uuid references public.products (id) on delete restrict;

alter table public.orders add constraint orders_item_exactly_one check (
  (course_offering_id is not null and product_id is null)
  or (course_offering_id is null and product_id is not null)
);

-- product_id가 null인 행(수업 주문)끼리는 이 제약이 서로 간섭하지 않는다(NULL은 유니크
-- 제약에서 서로 다른 값으로 취급된다) — 수업 쪽 UNIQUE(user_id, course_offering_id)는 그대로다.
alter table public.orders add constraint orders_user_id_product_id_key unique (user_id, product_id);

-- =====================================================================
-- 3. 학생 개인 시간표 겹침 트리거 — 물품 주문(course_offering_id가 null)은 애초에 시간표와
--    무관하므로 대상에서 뺀다(트리거 자체는 유지, 물품까지 검사할 이유는 없다).
-- =====================================================================
create or replace function public.check_no_student_schedule_conflict()
returns trigger
language plpgsql
as $$
begin
  if new.course_offering_id is null then
    return new;
  end if;

  if new.status not in ('PENDING', 'APPROVED') then
    return new;
  end if;

  if exists (
    select 1
    from public.orders o
    join public.course_sessions cs_old on cs_old.course_offering_id = o.course_offering_id
    join public.course_sessions cs_new on cs_new.course_offering_id = new.course_offering_id
    where o.user_id = new.user_id
      and o.id <> new.id
      and o.status in ('PENDING', 'APPROVED')
      and cs_old.day_of_week = cs_new.day_of_week
      and public.timerange(cs_old.start_time, cs_old.end_time) && public.timerange(cs_new.start_time, cs_new.end_time)
      and daterange(cs_old.valid_from, cs_old.valid_until, '[]') && daterange(cs_new.valid_from, cs_new.valid_until, '[]')
  ) then
    raise exception '겹치는 시간대에 신청/등록된 다른 강의가 있어 신청할 수 없습니다.';
  end if;

  return new;
end;
$$;

-- =====================================================================
-- 4. payment_events — order_id를 NOT NULL로 만든다(이제 모든 결제가 반드시 주문 하나에
--    묶인다). purpose·user_id는 그래서 더 필요 없다: "무엇을 샀나"는 orders가 가리키는
--    course_offering_id/product_id로 이미 알고, "누구 것인가"도 orders.user_id로 안다.
-- =====================================================================
do $$
declare
  v_null_order_id integer;
begin
  select count(*) into v_null_order_id from public.payment_events where order_id is null;
  if v_null_order_id > 0 then
    raise exception 'payment_events에 order_id가 없는 행이 %건 있습니다 — 마이그레이션을 중단합니다.', v_null_order_id;
  end if;
end $$;

-- "본인 결제 이력만 조회 가능" 정책이 user_id 컬럼에 기대고 있다 — 컬럼을 지우려면
-- 정책부터 먼저 지워야 한다("other objects depend on it").
drop policy "본인 결제 이력만 조회 가능" on public.payment_events;

alter table public.payment_events drop constraint payment_events_user_id_required;
alter table public.payment_events drop constraint payment_events_purpose_check;
alter table public.payment_events drop constraint payment_events_purpose_enrollment_check;
alter table public.payment_events alter column order_id set not null;
alter table public.payment_events drop column purpose;
alter table public.payment_events drop column user_id;

-- orders 조인만으로 다시 만든다.
create policy "본인 결제 이력만 조회 가능"
  on public.payment_events for select
  using (
    exists (
      select 1 from public.orders o
      where o.id = payment_events.order_id and o.user_id = current_profile_id()
    )
  );

-- =====================================================================
-- 5. apply_for_offering() → create_order() — 수업이면 지금 로직(판매 기간·좌석 예약)
--    그대로, 물품이면 판매 중인지만 확인하고 좌석 없이 진행한다. 둘 다 가격 확정·APPLIED
--    이벤트·약관 동의는 공통이다.
-- =====================================================================
drop function public.apply_for_offering(uuid, uuid, uuid[]);

create function public.create_order(
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

  return v_order_id;
end;
$$;

revoke execute on function public.create_order(uuid, uuid, uuid, uuid[])
  from public, anon, authenticated;

-- =====================================================================
-- 6. transition_order()/cancel_own_order() — 좌석 반환은 수업 주문(course_offering_id가
--    있는 경우)일 때만 한다. 물품 주문은 좌석이라는 개념 자체가 없다.
-- =====================================================================
drop function public.transition_order(uuid, uuid, text, text);

create function public.transition_order(
  p_order_id uuid,
  p_actor_id uuid,
  p_event_type text,
  p_next_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_email_verified boolean;
  v_actor_role text;
  v_allowed_from text[];
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

  if p_next_status = 'APPROVED' then
    select email_verified into v_email_verified
    from public.users where id = v_order.user_id;

    if coalesce(v_email_verified, false) is not true then
      raise exception '이 학생은 디스코드에서 이메일 인증을 해야 합니다. 인증 후 다시 로그인하면 승인할 수 있습니다.';
    end if;
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

  select role into v_actor_role from public.users where id = p_actor_id;

  insert into public.order_events (event_type, actor, actor_user_id, order_id)
  values (
    p_event_type,
    case when v_actor_role = 'ADMIN' then 'ADMIN' else 'MANAGER' end,
    p_actor_id,
    p_order_id
  );

  if p_next_status in ('REJECTED', 'CANCELLED') and v_order.course_offering_id is not null then
    perform public.release_course_offering_seat(v_order.course_offering_id);
  end if;
end;
$$;

revoke execute on function public.transition_order(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.transition_order(uuid, uuid, text, text)
  to service_role;

drop function public.cancel_own_order(uuid, uuid);

create function public.cancel_own_order(p_order_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
begin
  select id, user_id, course_offering_id, status, payment_status
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if v_order.id is null then
    raise exception '신청 내역을 찾을 수 없습니다.';
  end if;

  if v_order.user_id <> p_user_id then
    raise exception '본인의 신청 건만 취소할 수 있습니다.';
  end if;

  if v_order.payment_status <> 'UNPAID' then
    raise exception '이미 결제된 건은 여기서 취소할 수 없습니다. 환불은 관리자에게 문의해 주세요.';
  end if;

  update public.orders
  set status = 'CANCELLED',
      cancelled_at = now()
  where id = p_order_id
    and status in ('PENDING', 'APPROVED');

  if not found then
    raise exception '이미 종료되었거나 취소된 신청 건입니다.'
      using errcode = 'restrict_violation';
  end if;

  insert into public.order_events (event_type, actor, actor_user_id, order_id)
  values ('CANCELLED', 'STUDENT', p_user_id, p_order_id);

  if v_order.course_offering_id is not null then
    perform public.release_course_offering_seat(v_order.course_offering_id);
  end if;
end;
$$;

revoke execute on function public.cancel_own_order(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_own_order(uuid, uuid)
  to service_role;

-- =====================================================================
-- 7. record_payment_event() — p_purpose·p_user_id 인자를 뺀다(orders가 이미 둘 다 안다).
--    좌석 반환은 수업 주문일 때만(course_offering_id가 있을 때만) 한다.
-- =====================================================================
drop function public.record_payment_event(text, text, text, integer, text, text, uuid, uuid, text, jsonb, jsonb, text);

create function public.record_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_amount integer,
  p_currency text,
  p_order_id uuid,
  p_payment_method text,
  p_metadata jsonb,
  p_raw_payload jsonb,
  p_provider_transaction_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_owner_id uuid;
  v_offering_id uuid;
  v_final_amount integer;
  v_order_status text;
  v_payment_status text;
begin
  select user_id, course_offering_id, final_amount, status, payment_status
    into v_owner_id, v_offering_id, v_final_amount, v_order_status, v_payment_status
  from public.orders where id = p_order_id;

  if v_owner_id is null then
    raise exception '존재하지 않는 주문: %', p_order_id;
  end if;

  insert into public.payment_events (
    provider, provider_event_id, provider_transaction_id, event_type, amount, currency,
    order_id, payment_method, metadata, raw_payload
  ) values (
    p_provider, p_provider_event_id, p_provider_transaction_id, p_event_type, p_amount, p_currency,
    p_order_id, p_payment_method, p_metadata, p_raw_payload
  )
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return false;
  end if;

  if p_event_type = 'PAYMENT_SUCCEEDED' then
    if v_final_amount is null or p_amount is distinct from v_final_amount then
      insert into public.webhook_failures (source, payload, error_message)
      values (
        p_provider,
        p_raw_payload,
        '결제 금액이 청구 금액과 다름(상태 반영 안 함, 대사·환불 확인 필요) — order_id='
          || p_order_id::text
          || ', 청구=' || coalesce(v_final_amount::text, 'null')
          || ', 수신=' || coalesce(p_amount::text, 'null')
          || ', payment_event_id=' || v_event_id::text
      );
      return true;
    end if;

    update public.orders
    set payment_status = 'PAID', paid_at = now(), payment_method = p_payment_method
    where id = p_order_id
      and payment_status = 'UNPAID'
      and status = 'APPROVED';

    if not found then
      insert into public.webhook_failures (source, payload, error_message)
      values (
        p_provider,
        p_raw_payload,
        case
          when v_payment_status is distinct from 'UNPAID' then
            '이미 결제완료(PAID)된 신청 건에 결제성공 이벤트가 다시 들어옴(이중결제 의심) — order_id='
              || p_order_id::text || ', payment_event_id=' || v_event_id::text
          else
            '주문 상태가 APPROVED가 아닌 건에 결제성공 이벤트가 들어옴(결제 진행 중 취소·반려 의심, 환불 검토 필요) — order_id='
              || p_order_id::text
              || ', status=' || coalesce(v_order_status, 'null')
              || ', payment_event_id=' || v_event_id::text
        end
      );
      return true;
    end if;

    insert into public.outbox_messages (topic, payload)
    values (
      'GRANT_ENTITLEMENTS',
      jsonb_build_object(
        'payment_event_id', v_event_id,
        'user_id', v_owner_id,
        'order_id', p_order_id,
        'metadata', p_metadata
      )
    );
  elsif p_event_type = 'REFUNDED' then
    update public.orders
    set payment_status = 'REFUNDED',
        refunded_at = now(),
        status = 'CANCELLED',
        cancelled_at = coalesce(cancelled_at, now())
    where id = p_order_id and payment_status = 'PAID';

    if not found then
      insert into public.webhook_failures (source, payload, error_message)
      values (
        p_provider,
        p_raw_payload,
        '결제완료 상태가 아닌 신청 건에 환불 이벤트가 들어옴(상태 반영 안 함) — order_id='
          || p_order_id::text
          || ', payment_status=' || coalesce(v_payment_status, 'null')
          || ', payment_event_id=' || v_event_id::text
      );
      return true;
    end if;

    if v_order_status is distinct from 'CANCELLED'
       and v_order_status is distinct from 'REJECTED'
       and v_offering_id is not null then
      perform public.release_course_offering_seat(v_offering_id);
    end if;

    insert into public.outbox_messages (topic, payload)
    values (
      'REVOKE_ENTITLEMENTS',
      jsonb_build_object(
        'user_id', v_owner_id,
        'order_id', p_order_id,
        'reason', 'REFUNDED'
      )
    );
  end if;

  return true;
end;
$$;

revoke execute on function public.record_payment_event(text, text, text, integer, text, uuid, text, jsonb, jsonb, text)
  from public, anon, authenticated;

-- =====================================================================
-- 8. delete_course_offering() 등 나머지 — course_offering_id 기준 카운트라 물품과 무관하다,
--    변경 없음. consume_entitlement()도 entitlements.order_id를 그대로 쓰므로 무변경이다.
-- =====================================================================
