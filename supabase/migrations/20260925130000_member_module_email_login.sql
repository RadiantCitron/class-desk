-- (2026-09-25 재설계) — 회원 모듈: 이메일 매직링크로만 가입·로그인
-- (비밀번호 없음), 디스코드는 연결만, 탈퇴·복구, 회원 이벤트 테이블, 이메일 중복 가입 금지,
-- 매니저 자격 검증 함수 분리. email_verified 제거(이메일 인증을 켜면 로그인 자체가 인증된 이메일).

-- =====================================================================
-- 1. account_events — 회원 모듈의 자기 이벤트 테이블(INSERT만, 불변성 트리거). 값이 되돌아가거나
-- 여러 번 바뀌는 회원 상태(탈퇴↔복구, 디스코드 연결)의 이력(②).
-- =====================================================================
create table public.account_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete restrict,
  event_type text not null check (event_type in (
    'SIGNED_UP', 'IDENTITY_LINKED', 'WITHDRAWN', 'REACTIVATED'
  )),
  actor text not null check (actor in ('SELF', 'SYSTEM')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index account_events_user_created_idx on public.account_events (user_id, created_at desc);

alter table public.account_events enable row level security;

-- 쓰기 정책은 두지 않는다 — 아래 security definer 함수로만 쓴다(RLS 기본 거부).
create policy "관리자만 회원 이벤트 조회 가능"
  on public.account_events for select
  using (is_admin());

create trigger account_events_forbid_app_update_delete
  before update or delete on public.account_events
  for each row execute function public.event_log_forbid_app_update_delete();

-- =====================================================================
-- 2. users — 디스코드는 가입 뒤에 연결하므로 비어 있을 수 있다. 이메일은 유니크
--    ("같은 이메일인 유저가 있으면 가입실패다"). auth.users.email이 이미 유니크라 실전에서 이
--    제약에 걸릴 일은 거의 없지만, 다른 경로의 실수를 막는 방어선으로 둔다.
-- =====================================================================
alter table public.users alter column discord_id drop not null;
alter table public.users add constraint users_email_key unique (email);

-- =====================================================================
-- 3. email_verified를 읽는 함수 2개를 먼저 고친다(매개변수 그대로 → create or replace, 권한 유지).
-- =====================================================================
create or replace function public.transition_order(
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

-- =====================================================================
-- 4. 매니저 자격 검증 — set_manager가 하던 역할·탈퇴 검사를 재사용 가능한 함수로
--    뺀다. 디스코드 연결 여부는 검사하지 않는다(P11 — 디스코드는 매니저 자격과 무관, 2026-09-25).
-- =====================================================================
create function public.assert_manager_eligible(p_user_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_role text;
  v_withdrawn timestamptz;
begin
  select role, withdrawn_at into v_role, v_withdrawn
  from public.users
  where id = p_user_id
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
end;
$$;

revoke execute on function public.assert_manager_eligible(uuid) from public, anon, authenticated;
grant execute on function public.assert_manager_eligible(uuid) to service_role;

create or replace function public.set_manager(p_target uuid, p_actor uuid, p_view boolean, p_approve boolean, p_pay boolean)
returns void
language plpgsql
as $$
begin
  perform public.assert_manager_eligible(p_target);

  update public.users set role = 'MANAGER' where id = p_target;

  update public.manager_permissions
  set can_view_students = p_view,
      can_approve_orders = p_approve,
      can_approve_payments = p_pay,
      granted_by = p_actor
  where user_id = p_target and revoked_at is null;

  if not found then
    insert into public.manager_permissions
      (user_id, can_view_students, can_approve_orders, can_approve_payments, granted_by)
    values
      (p_target, p_view, p_approve, p_pay, p_actor);
  end if;
end;
$$;

-- =====================================================================
-- 5. complete_signup — 가입 수단은 이메일뿐. 디스코드·비밀번호·이메일인증 매개변수가 전혀
--    없으므로 drop 후 create. 최종 가드: 이메일 신원이 있는 인증 계정만 받는다(수파인증 설정이
--    어떻든 우리 회원 모듈이 "가입은 이메일로만"을 강제한다).
-- =====================================================================
drop function public.complete_signup(uuid, text, text, boolean, uuid, uuid);

create function public.complete_signup(
  p_auth_user_id uuid,
  p_email text,
  p_service_terms_id uuid,
  p_privacy_terms_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
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

  insert into public.users (auth_user_id, email, role)
  values (p_auth_user_id, p_email, 'STUDENT')
  returning id into v_user_id;

  insert into public.account_events (user_id, event_type, actor)
  values (v_user_id, 'SIGNED_UP', 'SELF');

  insert into public.terms_agreements (user_id, terms_id) values
    (v_user_id, p_service_terms_id),
    (v_user_id, p_privacy_terms_id);

  return v_user_id;
end;
$$;

revoke execute on function public.complete_signup(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_signup(uuid, text, uuid, uuid)
  to service_role;

-- =====================================================================
-- 6. 회원 모듈 명령 함수 3개. 전부 service_role 전용.
-- =====================================================================

-- 디스코드 연결 기록. 연결 해제·교체는 없다(1-5-6 ⑦) — 이미 다른 디스코드가 붙어
-- 있으면 거부. 다른 회원에게 붙은 디스코드면 users_discord_id_key 유니크가 23505로 막는다.
create function public.link_discord_identity(p_user_id uuid, p_discord_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
begin
  select discord_id into v_current from public.users where id = p_user_id for update;
  if not found then
    raise exception '회원을 찾을 수 없습니다.';
  end if;

  if v_current = p_discord_id then
    return; -- 같은 디스코드로 다시 연결 — 이미 기록돼 있다(멱등)
  end if;

  if v_current is not null then
    raise exception '이미 다른 디스코드 계정이 연결되어 있습니다. 관리자에게 문의해 주세요.';
  end if;

  update public.users set discord_id = p_discord_id where id = p_user_id;

  insert into public.account_events (user_id, event_type, actor, detail)
  values (p_user_id, 'IDENTITY_LINKED', 'SELF', jsonb_build_object('provider', 'discord'));
end;
$$;

-- 탈퇴(1-5-4 ⑤) — 탈퇴 표시 + 회원 이벤트 + USER_WITHDRAWN 사실을 한 트랜잭션으로.
create function public.withdraw_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.users set withdrawn_at = now()
  where id = p_user_id and withdrawn_at is null;
  if not found then
    raise exception '이미 탈퇴했거나 회원을 찾을 수 없습니다.';
  end if;

  insert into public.account_events (user_id, event_type, actor)
  values (p_user_id, 'WITHDRAWN', 'SELF');

  insert into public.outbox_messages (topic, payload)
  values ('USER_WITHDRAWN', jsonb_build_object('user_id', p_user_id));
end;
$$;

-- 복구(1-5-4 ⑥) — 같은 users.id로. 약관 재동의를 원자적으로. 이미 같은 버전에 동의한 기록이 있으면
-- 그 약관은 다시 넣지 않는다. 이용권·디스코드 역할은 되살리지 않는다.
create function public.reactivate_user(p_user_id uuid, p_service_terms_id uuid, p_privacy_terms_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.users set withdrawn_at = null
  where id = p_user_id and withdrawn_at is not null;
  if not found then
    raise exception '탈퇴 상태가 아니거나 회원을 찾을 수 없습니다.';
  end if;

  insert into public.terms_agreements (user_id, terms_id)
  select p_user_id, t.id
  from (values (p_service_terms_id), (p_privacy_terms_id)) as t(id)
  where not exists (
    select 1 from public.terms_agreements a
    where a.user_id = p_user_id and a.terms_id = t.id
  );

  insert into public.account_events (user_id, event_type, actor)
  values (p_user_id, 'REACTIVATED', 'SELF');
end;
$$;

revoke execute on function public.link_discord_identity(uuid, text) from public, anon, authenticated;
grant execute on function public.link_discord_identity(uuid, text) to service_role;
revoke execute on function public.withdraw_user(uuid) from public, anon, authenticated;
grant execute on function public.withdraw_user(uuid) to service_role;
revoke execute on function public.reactivate_user(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.reactivate_user(uuid, uuid, uuid) to service_role;

-- =====================================================================
-- 7. 미인증 계정 선점 방어(G-T1, 작업 2에서 항상 만들기로 확정) — 가입 링크를 보내기 전, 그 이메일로
--    누군가 미리 만들어 둔 "미인증" 인증 계정이 있는지 서버가 확인한다.
-- =====================================================================
create function public.auth_account_state_by_email(p_email text)
returns table (auth_user_id uuid, email_confirmed boolean)
language sql
security definer
set search_path = public, auth
stable
as $$
  select u.id, u.email_confirmed_at is not null
  from auth.users u
  where lower(u.email) = lower(p_email)
  limit 1;
$$;

revoke execute on function public.auth_account_state_by_email(text) from public, anon, authenticated;
grant execute on function public.auth_account_state_by_email(text) to service_role;

-- =====================================================================
-- 8. email_verified 컬럼 제거 — 함수 본문은 카탈로그가 의존성을 추적하지 않으므로(RENAME 때 겪은 것과
--    같은 원리), 아직 이 이름을 쓰는 함수가 남아 있으면 조용히 깨진다. 먼저 확인하고 멈춘다.
-- =====================================================================
do $$
declare
  v_fns text;
begin
  select string_agg(proname, ', ') into v_fns
  from pg_proc
  where pronamespace = 'public'::regnamespace and prosrc like '%email_verified%';
  if v_fns is not null then
    raise exception 'email_verified를 아직 쓰는 함수가 있습니다: % — 마이그레이션을 중단합니다.', v_fns;
  end if;
end $$;

alter table public.users drop column email_verified;
