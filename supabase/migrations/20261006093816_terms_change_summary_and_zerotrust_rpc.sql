-- 1. 약관 테이블에 비고란(change_summary) 추가
alter table public.terms add column if not exists change_summary text;

-- 2. get_pending_terms RPC 작성 (특정 유저가 동의해야 할 필수 약관 중 미동의 상태인 것 조회)
-- (SERVICE_USE, PRIVACY_USE) 필수 약관을 반환함.
create or replace function public.get_pending_terms(p_user_id uuid)
returns table(terms_id uuid, type text, version text, content text, change_summary text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with active_terms as (
    select distinct on (t.type)
      t.id, t.type, t.version, t.content, t.change_summary
    from public.terms t
    where t.type in ('SERVICE_USE', 'PRIVACY_USE')
      and t.effective_at <= now()
    order by t.type, t.effective_at desc, t.created_at desc
  )
  select a.id, a.type, a.version, a.content, a.change_summary
  from active_terms a
  left join public.terms_agreements ta 
    on ta.user_id = p_user_id and ta.terms_id = a.id
  where ta.id is null;
end;
$$;
grant execute on function public.get_pending_terms(uuid) to service_role;

-- 3. complete_signup() 교차 검증 로직 보강
create or replace function public.complete_signup(
  p_auth_user_id uuid,
  p_email text,
  p_service_terms_id uuid,
  p_privacy_terms_id uuid,
  p_marketing_terms_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_active_service_id uuid;
  v_active_privacy_id uuid;
begin
  if not public.gate_open('SIGNUP') then
    raise exception '현재 신규 가입이 일시 중단되었습니다. 잠시 후 다시 시도해 주세요.'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from auth.identities
    where user_id = p_auth_user_id and provider = 'email'
  ) then
    raise exception '이메일로 가입한 계정만 회원이 될 수 있습니다.'
      using errcode = 'insufficient_privilege';
  end if;

  -- [Zero-Trust] 클라이언트가 보낸 약관 ID가 현재 Active 상태인지 1:1 교차 검증
  select id into v_active_service_id from public.terms where type = 'SERVICE_USE' and effective_at <= now() order by effective_at desc, created_at desc limit 1;
  select id into v_active_privacy_id from public.terms where type = 'PRIVACY_USE' and effective_at <= now() order by effective_at desc, created_at desc limit 1;

  if p_service_terms_id != v_active_service_id then
    raise exception '최신 서비스 이용약관에 동의해야 합니다.';
  end if;
  if p_privacy_terms_id != v_active_privacy_id then
    raise exception '최신 개인정보 수집·이용 약관에 동의해야 합니다.';
  end if;
  -- 마케팅은 선택약관이나, 만약 ID가 들어왔다면 해당 타입의 활성 약관이 맞는지 체크
  if p_marketing_terms_id is not null then
    if not exists (
      select 1 from (
        select id from public.terms where type = 'MARKETING_OPT_IN' and effective_at <= now() order by effective_at desc, created_at desc limit 1
      ) active_term where active_term.id = p_marketing_terms_id
    ) then
      -- 선택 약관이므로 에러 발생보다는 null 처리하거나 무시할 수 있으나, 위조 시도 차단을 위해 예외 발생
      raise exception '유효하지 않은 마케팅 약관입니다.';
    end if;
  end if;

  insert into public.users (auth_user_id, email, role, marketing_email_opt_in)
  values (p_auth_user_id, p_email, 'STUDENT', p_marketing_terms_id is not null)
  returning id into v_user_id;

  insert into public.account_events (user_id, event_type, actor)
  values (v_user_id, 'SIGNED_UP', 'SELF');

  insert into public.terms_agreements (user_id, terms_id) values
  (v_user_id, p_service_terms_id),
  (v_user_id, p_privacy_terms_id);

  if p_marketing_terms_id is not null then
    insert into public.terms_agreements (user_id, terms_id) values (v_user_id, p_marketing_terms_id);
  end if;

  return v_user_id;
end;
$$;
revoke execute on function public.complete_signup(uuid, text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_signup(uuid, text, uuid, uuid, uuid) to service_role;

-- 4. create_order() 교차 검증 로직 보강
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

  -- 주문 생성 (최소 1건의 내역 보장)
  insert into public.orders (user_id, status)
  values (p_user_id, 'PENDING')
  returning id into v_order_id;

  if p_course_offering_id is not null then
    insert into public.order_items (order_id, course_offering_id, unit_price)
    values (v_order_id, p_course_offering_id, v_price);
  else
    insert into public.order_items (order_id, product_id, unit_price)
    values (v_order_id, p_product_id, v_price);
  end if;

  insert into public.order_events (order_id, event_type, status, actor)
  values (v_order_id, 'CREATED', 'PENDING', 'USER');

  if p_terms_ids is not null and array_length(p_terms_ids, 1) > 0 then
    foreach v_terms_id in array p_terms_ids loop
      -- [Zero-Trust] 넘겨받은 v_terms_id가 해당 타입의 "최신 활성 약관"인지 검증
      if not exists (
        select 1 from (
          select id from public.terms 
          where type = (select type from public.terms where id = v_terms_id)
            and effective_at <= now() 
          order by effective_at desc, created_at desc 
          limit 1
        ) active_term
        where active_term.id = v_terms_id
      ) then
        raise exception '유효하지 않거나 최신이 아닌 약관(%)에 동의 시도가 감지되었습니다.', v_terms_id;
      end if;

      insert into public.terms_agreements (user_id, terms_id, order_id)
      values (p_user_id, v_terms_id, v_order_id);
    end loop;
  end if;

  -- 자동 승인 로직 등
  if p_course_offering_id is not null and exists (
    select 1 from public.course_offerings o
    where o.id = p_course_offering_id and o.auto_approve is true
  ) then
    update public.orders
    set status = 'APPROVED',
        approved_at = now()
    where id = v_order_id
      and status = 'PENDING';

    insert into public.order_events (order_id, event_type, status, actor)
    values (v_order_id, 'APPROVED', 'APPROVED', 'SYSTEM');
  end if;

  if p_product_id is not null and exists (
    select 1 from public.products p
    where p.id = p_product_id and p.auto_approve is true
  ) then
    update public.orders
    set status = 'APPROVED',
        approved_at = now()
    where id = v_order_id
      and status = 'PENDING';

    insert into public.order_events (order_id, event_type, status, actor)
    values (v_order_id, 'APPROVED', 'APPROVED', 'SYSTEM');
  end if;

  return v_order_id;
end;
$$;
