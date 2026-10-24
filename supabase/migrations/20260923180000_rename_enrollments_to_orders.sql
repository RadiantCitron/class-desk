-- DB 구조 재정립 4단계(2026-09-23) — 이름 바꾸기: enrollments → orders.
-- 가장 큰 단계이지만 동작은 바꾸지 않는다.
-- ALTER ... RENAME 중심으로 데이터를 보존한다(신규 테이블 생성 + 데이터 이관이 아니다).

-- =====================================================================
-- 1. 테이블 이름
-- =====================================================================
alter table public.enrollments rename to orders;
alter table public.enrollment_events rename to order_events;

-- =====================================================================
-- 2. 컬럼 이름을 바꾸기 전에, 값/이름이 함께 바뀌는 CHECK 제약부터 지운다.
--    (컬럼 rename은 제약 정의 안의 컬럼 참조를 자동으로 따라가지만, 값 리터럴 'ENROLLED' 같은
--    것은 자동으로 안 바뀐다 — 그래서 값을 바꿀 구간은 미리 제약을 걷어낸다.)
-- =====================================================================
alter table public.orders drop constraint enrollments_enrollment_status_check;
alter table public.orders drop constraint enrollments_status_consistency;
alter table public.orders drop constraint enrollments_payment_consistency;

-- =====================================================================
-- 3. 컬럼 이름
-- =====================================================================
alter table public.orders rename column enrollment_status to status;
alter table public.orders rename column enrolled_at to approved_at;
alter table public.orders rename column enrollment_cancelled_at to cancelled_at;
alter table public.orders rename column applied_at to created_at;
alter table public.orders rename column payment_cancelled_at to refunded_at;

alter table public.order_events rename column enrollment_id to order_id;
alter table public.payment_events rename column enrollment_id to order_id;
alter table public.entitlements rename column enrollment_id to order_id;
alter table public.terms_agreements rename column enrollment_id to order_id;

-- =====================================================================
-- 4. 상태값 ENROLLED → APPROVED. "신청 → 승인 → 등록"의 승인 결과를 가리키는 값인데,
--    이제 이 테이블이 수업만이 아니라 모든 구매를 담으므로(다음 5단계) 수업 전용 말투를 뺀다.
-- =====================================================================
update public.orders set status = 'APPROVED' where status = 'ENROLLED';

-- =====================================================================
-- 5. CHECK 제약을 새 이름·새 값으로 다시 만든다.
-- =====================================================================
alter table public.orders add constraint orders_status_check
  check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'));

alter table public.orders add constraint orders_status_consistency
  check (
    case status
      when 'PENDING'  then (approved_at is null and cancelled_at is null)
      when 'APPROVED' then (approved_at is not null and cancelled_at is null)
      when 'REJECTED' then (approved_at is null)
      when 'CANCELLED' then (cancelled_at is not null)
      else false
    end
  );

alter table public.orders add constraint orders_payment_consistency
  check (
    case payment_status
      when 'UNPAID' then (paid_at is null and payment_method is null and refunded_at is null)
      when 'PAID' then (paid_at is not null and payment_method is not null and refunded_at is null)
      when 'REFUNDED' then (
        paid_at is not null and payment_method is not null
        and refunded_at is not null and refunded_at >= paid_at
      )
      else false
    end
  );

-- =====================================================================
-- 6. 나머지 인덱스·제약 이름 정리(관례: <테이블>_<컬럼/의미>).
-- =====================================================================
alter index enrollments_pkey rename to orders_pkey;
alter index enrollments_applied_at_idx rename to orders_created_at_idx;
alter index enrollments_course_offering_id_idx rename to orders_course_offering_id_idx;
alter index enrollments_enrolled_at_idx rename to orders_approved_at_idx;
alter index enrollments_enrollment_status_idx rename to orders_status_idx;
alter index enrollments_final_amount_idx rename to orders_final_amount_idx;
alter index enrollments_payment_status_idx rename to orders_payment_status_idx;

alter table public.orders rename constraint enrollments_amount_sane to orders_amount_sane;
alter table public.orders rename constraint enrollments_course_offering_id_fkey to orders_course_offering_id_fkey;
alter table public.orders rename constraint enrollments_discount_rule_id_fkey to orders_discount_rule_id_fkey;
alter table public.orders rename constraint enrollments_payment_method_check to orders_payment_method_check;
alter table public.orders rename constraint enrollments_payment_status_check to orders_payment_status_check;
alter table public.orders rename constraint enrollments_user_id_course_offering_id_key to orders_user_id_course_offering_id_key;
alter table public.orders rename constraint enrollments_user_id_fkey to orders_user_id_fkey;

alter table public.order_events rename constraint enrollment_events_actor_check to order_events_actor_check;
alter table public.order_events rename constraint enrollment_events_actor_user_id_fkey to order_events_actor_user_id_fkey;
alter table public.order_events rename constraint enrollment_events_enrollment_id_fkey to order_events_order_id_fkey;
alter table public.order_events rename constraint enrollment_events_event_type_check to order_events_event_type_check;
alter table public.order_events rename constraint enrollment_events_pkey to order_events_pkey;

alter trigger enrollments_set_updated_at on public.orders rename to orders_set_updated_at;
-- 강사 확장 대비 저비용 안전장치로 트리거는 유지한다(제거하지 않는다). 이름만
-- 새 테이블 이름에 맞춘다 — 함수 본문은 이미 위 10절에서 orders/status를 쓰도록 갱신했다.
alter trigger enrollments_no_schedule_conflict on public.orders rename to orders_no_schedule_conflict;

alter table public.entitlements rename constraint entitlements_enrollment_id_fkey to entitlements_order_id_fkey;
alter index entitlements_enrollment_id_idx rename to entitlements_order_id_idx;
alter table public.terms_agreements rename constraint terms_agreements_enrollment_id_fkey to terms_agreements_order_id_fkey;
alter index terms_agreements_enrollment_id_idx rename to terms_agreements_order_id_idx;
alter table public.payment_events rename constraint payment_events_enrollment_id_fkey to payment_events_order_id_fkey;
alter index payment_events_enrollment_id_idx rename to payment_events_order_id_idx;

-- =====================================================================
-- 7. order_events.user_id / course_offering_id — 이제 order_id로 orders를 조인하면 알 수
--    있어 중복이다. 컬럼을 드롭하기 전에, 이 컬럼들에 의존하는 정책부터 다시 만든다
--    (안 그러면 "다른 객체가 의존 중"이라 DROP COLUMN이 실패한다).
-- =====================================================================
drop policy "본인 관련 이벤트만 조회 가능" on public.order_events;
create policy "본인 관련 이벤트만 조회 가능"
  on public.order_events for select
  using (
    exists (
      select 1 from public.orders o
      where o.id = order_events.order_id and o.user_id = current_profile_id()
    )
  );

alter index enrollment_events_enrollment_id_idx rename to order_events_order_id_idx;

alter table public.order_events drop column user_id;
alter table public.order_events drop column course_offering_id;
-- 위 두 컬럼의 FK 제약(enrollment_events_user_id_fkey/enrollment_events_course_offering_id_fkey)은
-- 컬럼과 함께 자동으로 사라진다.

-- =====================================================================
-- 8. 매니저 승인 권한 — APPROVE_ENROLLMENTS → APPROVE_ORDERS, can_approve_enrollments →
--    can_approve_orders. "승인"이 이제 수업 신청만이 아니라 모든 구매의 승인을 가리킨다.
-- =====================================================================
alter table public.manager_permissions rename column can_approve_enrollments to can_approve_orders;

create or replace function public.has_permission(p_permission text)
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select case
    when exists (
      select 1 from public.users
      where auth_user_id = auth.uid() and role = 'ADMIN' and withdrawn_at is null
    ) then true
    when p_permission = 'VIEW_STUDENTS' then exists (
      select 1 from public.users u
      join public.manager_permissions mp on mp.user_id = u.id
      where u.auth_user_id = auth.uid() and u.role = 'MANAGER' and u.withdrawn_at is null
        and mp.revoked_at is null and mp.can_view_students
    )
    when p_permission = 'APPROVE_ORDERS' then exists (
      select 1 from public.users u
      join public.manager_permissions mp on mp.user_id = u.id
      where u.auth_user_id = auth.uid() and u.role = 'MANAGER' and u.withdrawn_at is null
        and mp.revoked_at is null and mp.can_approve_orders
    )
    when p_permission = 'APPROVE_PAYMENTS' then exists (
      select 1 from public.users u
      join public.manager_permissions mp on mp.user_id = u.id
      where u.auth_user_id = auth.uid() and u.role = 'MANAGER' and u.withdrawn_at is null
        and mp.revoked_at is null and mp.can_approve_payments
    )
    else false
  end;
$$;

create or replace function public.set_manager(p_target uuid, p_actor uuid, p_view boolean, p_approve boolean, p_pay boolean)
returns void
language plpgsql
as $$
declare
  v_role text;
  v_withdrawn timestamptz;
  v_verified boolean;
begin
  select role, withdrawn_at, email_verified
    into v_role, v_withdrawn, v_verified
  from public.users
  where id = p_target
  for update;

  if not found then
    raise exception '대상 회원을 찾을 수 없습니다.';
  end if;

  if v_role not in ('STUDENT', 'MANAGER') then
    raise exception 'ADMIN 계정은 매니저로 지정할 수 없습니다.';
  end if;

  if v_withdrawn is not null then
    raise exception '탈퇴한 계정은 매니저로 지정할 수 없습니다.';
  end if;

  if not v_verified then
    raise exception '이메일 인증이 되지 않은 계정은 매니저로 지정할 수 없습니다.';
  end if;

  update public.users set role = 'MANAGER' where id = p_target;

  insert into public.manager_permissions
    (user_id, can_view_students, can_approve_orders, can_approve_payments, granted_by, revoked_at)
  values
    (p_target, p_view, p_approve, p_pay, p_actor, null)
  on conflict (user_id) do update set
    can_view_students = excluded.can_view_students,
    can_approve_orders = excluded.can_approve_orders,
    can_approve_payments = excluded.can_approve_payments,
    granted_by = excluded.granted_by,
    revoked_at = null;
end;
$$;

create or replace function public.revoke_manager(p_target uuid)
returns void
language plpgsql
as $$
declare
  v_role text;
begin
  select role into v_role from public.users where id = p_target for update;

  if not found then
    raise exception '대상 회원을 찾을 수 없습니다.';
  end if;

  if v_role <> 'MANAGER' then
    raise exception '매니저가 아닌 계정입니다.';
  end if;

  update public.users set role = 'STUDENT' where id = p_target;

  update public.manager_permissions
  set can_view_students = false,
      can_approve_orders = false,
      can_approve_payments = false,
      revoked_at = now()
  where user_id = p_target;
end;
$$;

-- orders RLS의 "권한 있는 매니저는 조회 가능" 정책이 has_permission('APPROVE_ENROLLMENTS')를
-- 문자열로 부르고 있었다 — has_permission()이 이제 'APPROVE_ORDERS'만 알아보므로 다시 만든다.
drop policy "권한 있는 매니저는 수강신청 조회 가능" on public.orders;
create policy "권한 있는 매니저는 수강신청 조회 가능"
  on public.orders for select
  using (has_permission('VIEW_STUDENTS') or has_permission('APPROVE_ORDERS'));

-- =====================================================================
-- 9. 함수 이름: transition_enrollment → transition_order, cancel_own_enrollment →
--    cancel_own_order. 본문은 새 테이블·컬럼·값 이름을 쓰도록 함께 갱신한다.
-- =====================================================================
drop function public.transition_enrollment(uuid, uuid, text, text);

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

  if p_next_status in ('REJECTED', 'CANCELLED') then
    perform public.release_course_offering_seat(v_order.course_offering_id);
  end if;
end;
$$;

drop function public.cancel_own_enrollment(uuid, uuid);

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

  perform public.release_course_offering_seat(v_order.course_offering_id);
end;
$$;

-- drop+create로 새 함수 객체가 됐으므로, 예전 함수에 걸려 있던 REVOKE/GRANT가 안 따라온다
-- (Postgres 기본값은 새 함수에 PUBLIC EXECUTE를 준다) — 옛 함수와 똑같이 다시 잠근다
-- (20260921130000_type2_atomicity_rpcs.sql, 20260923120000_cancel_own_enrollment.sql과 동일 원칙).
revoke execute on function public.transition_order(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.transition_order(uuid, uuid, text, text)
  to service_role;

revoke execute on function public.cancel_own_order(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_own_order(uuid, uuid)
  to service_role;

-- =====================================================================
-- 10. 나머지 함수 — 이름은 유지하되 본문에서 새 테이블·컬럼 이름을 쓰도록 갱신한다.
-- =====================================================================

-- apply_for_offering: 5단계(create_order로 개명 + 물품 지원)에서 더 크게 바뀔 예정이라,
-- 이번엔 이름을 그대로 두고 새 테이블/컬럼 이름만 반영한다.
create or replace function public.apply_for_offering(p_user_id uuid, p_offering_id uuid, p_terms_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offering record;
  v_reserved boolean;
  v_order_id uuid;
  v_terms_id uuid;
begin
  select id, price into v_offering
  from public.course_offerings
  where id = p_offering_id
    and status = 'OPEN'
    and deleted_at is null
    and now() >= opens_at
    and (ends_at is null or now() <= ends_at);

  if v_offering.id is null then
    raise exception '신청할 수 없는 개설강의입니다.';
  end if;

  select public.reserve_course_offering_seat(p_offering_id) into v_reserved;
  if not coalesce(v_reserved, false) then
    raise exception '정원이 마감되어 신청할 수 없습니다.';
  end if;

  begin
    insert into public.orders (user_id, course_offering_id, list_price, final_amount)
    values (p_user_id, p_offering_id, v_offering.price, v_offering.price)
    returning id into v_order_id;
  exception when unique_violation then
    perform public.release_course_offering_seat(p_offering_id);
    raise exception '이미 신청한 강의입니다.';
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

-- create or replace는 매개변수 "이름"이 바뀌면 실패한다(타입 목록이 같아도) — p_enrollment_id
-- 를 p_order_id로 바꾸므로 예전 정의를 먼저 지운다.
drop function public.record_payment_event(text, text, text, integer, text, text, uuid, uuid, text, jsonb, jsonb, text);

create function public.record_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_amount integer,
  p_currency text,
  p_purpose text,
  p_order_id uuid,
  p_user_id uuid,
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
  if p_order_id is not null then
    select user_id, course_offering_id, final_amount, status, payment_status
      into v_owner_id, v_offering_id, v_final_amount, v_order_status, v_payment_status
    from public.orders where id = p_order_id;

    if v_owner_id is null then
      raise exception '존재하지 않는 수강신청: %', p_order_id;
    end if;
  else
    v_owner_id := p_user_id;
  end if;

  insert into public.payment_events (
    provider, provider_event_id, provider_transaction_id, event_type, amount, currency, purpose,
    order_id, user_id, payment_method, metadata, raw_payload
  ) values (
    p_provider, p_provider_event_id, p_provider_transaction_id, p_event_type, p_amount, p_currency, p_purpose,
    p_order_id, v_owner_id, p_payment_method, p_metadata, p_raw_payload
  )
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return false;
  end if;

  if p_event_type = 'PAYMENT_SUCCEEDED' then
    if p_order_id is not null then
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
              '이미 결제완료(PAID)된 수강신청에 결제성공 이벤트가 다시 들어옴(이중결제 의심) — order_id='
                || p_order_id::text || ', payment_event_id=' || v_event_id::text
            else
              '수강 상태가 APPROVED가 아닌 신청 건에 결제성공 이벤트가 들어옴(결제 진행 중 취소·반려 의심, 환불 검토 필요) — order_id='
                || p_order_id::text
                || ', status=' || coalesce(v_order_status, 'null')
                || ', payment_event_id=' || v_event_id::text
          end
        );
        return true;
      end if;
    end if;

    insert into public.outbox_messages (topic, payload)
    values (
      'GRANT_ENTITLEMENTS',
      jsonb_build_object(
        'payment_event_id', v_event_id,
        'user_id', v_owner_id,
        'order_id', p_order_id,
        'purpose', p_purpose,
        'metadata', p_metadata
      )
    );
  elsif p_event_type = 'REFUNDED' and p_order_id is not null then
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
       and v_order_status is distinct from 'REJECTED' then
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

-- record_payment_event도 drop+create로 새 함수 객체가 됐다 — 원래 걸려 있던 REVOKE를
-- 다시 건다(20260918100000_manager_permissions.sql의 8개 민감 RPC 원칙과 동일).
revoke execute on function public.record_payment_event(text, text, text, integer, text, text, uuid, uuid, text, jsonb, jsonb, text)
  from public, anon, authenticated;

create or replace function public.check_no_student_schedule_conflict()
returns trigger
language plpgsql
as $$
begin
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

create or replace function public.delete_course_offering(p_offering_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_order_count integer;
begin
  select count(*) into v_order_count
  from public.orders
  where course_offering_id = p_offering_id;

  if v_order_count > 0 then
    raise exception '삭제 실패(신청 내역이 있으면 삭제할 수 없습니다).';
  end if;

  delete from public.course_sessions where course_offering_id = p_offering_id;

  update public.course_offerings
  set deleted_at = now()
  where id = p_offering_id;
end;
$$;
