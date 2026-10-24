-- 매니저(MANAGER) 역할과 권한 테이블을 도입한다.
--
-- 배경: 지금까지는 ADMIN(강사 본인) 한 명이 모든 관리 작업을 했다. 조교 같은 보조 인력에게
-- "정해진 일만" 맡기려면 역할이 하나 더 필요하고, 사람마다 켜고 끌 수 있는 권한이 필요하다.
-- 권한 목록은 리눅스 rwx처럼 테이블 하나에 boolean 칼럼으로 둔다(사용자 지정 방식).
--
-- 사용자가 확정한 것(2026-09-18):
--   - 매니저는 이미 가입한 회원을 "승격"해서 만든다(사이트가 Discord 계정을 직접 만들 수 없음).
--   - 박탈하면 STUDENT로 되돌린다(행은 지우지 않는다 — 이 저장소의 삭제 금지 원칙).
--   - ADMIN은 "내가 쿼리로 DB에 직접 넣는다, 다른 방법은 없다" — DB가 구조적으로 차단한다.
--   - 수강신청승인 권한은 승인·반려·결제 전 취소를 모두 포함한다.
--   - 권한 3종: 수강생 조회(VIEW_STUDENTS), 수강신청 승인(APPROVE_ENROLLMENTS),
--     결제 승인(APPROVE_PAYMENTS — 결제는 개발 중이라 지금은 버튼만 만든다).
--
-- 전수조사(2026-09-18)로 이 마이그레이션 전에 이미 존재하던 구멍 하나도 여기서 함께 막는다:
-- complete_signup/apply_for_offering/record_payment_event/consume_entitlement/
-- reserve_course_offering_seat/release_course_offering_seat 6개 함수는 SECURITY DEFINER라
-- RLS를 우회하는데, 실행 권한을 거두는 GRANT/REVOKE가 이 저장소 어디에도 없었다. 즉
-- 로그인한 사람은 누구나 이 함수들을 PostgREST로 직접 불러 예를 들어
-- complete_signup(p_role:'ADMIN', ...)으로 스스로 ADMIN이 되거나 record_payment_event로
-- 결제 완료를 위조할 수 있었다(로컬 DB에서 has_function_privilege로 실제 확인함, 2026-09-18).

-- =========================================================
-- 1. users.role — MANAGER 추가
-- =========================================================
alter table public.users drop constraint users_role_check;
alter table public.users
  add constraint users_role_check
    check (role in ('ADMIN', 'MANAGER', 'STUDENT'));

-- 매니저가 승인/반려/취소한 이력도 "누가 했는지" 남겨야 한다.
alter table public.enrollment_events drop constraint enrollment_events_actor_check;
alter table public.enrollment_events
  add constraint enrollment_events_actor_check
    check (actor in ('SYSTEM', 'ADMIN', 'STUDENT', 'MANAGER'));

-- =========================================================
-- 2. 권한 테이블 — 칼럼 하나가 권한 하나(rwx 방식). 매니저 1인당 행 1개.
--    revoked_at은 박탈 표시용이며 행을 지우지 않는다(누가 언제 무슨 권한을 가졌었는지 보존).
-- =========================================================
create table public.manager_permissions (
  user_id uuid primary key references public.users (id) on delete restrict,
  can_view_students boolean not null default false,
  can_approve_enrollments boolean not null default false,
  can_approve_payments boolean not null default false,
  granted_by uuid not null references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);

create trigger manager_permissions_set_updated_at
  before update on public.manager_permissions
  for each row execute function set_updated_at();

alter table public.manager_permissions enable row level security;

-- 조회 정책 2개(OR로 합쳐짐, users 테이블의 기존 관례와 동일한 모양).
-- insert/update/delete 정책은 두지 않는다 — 쓰기는 아래 set_manager()/revoke_manager()가
-- service_role로만 수행한다(클라이언트는 직접 쓸 수 없다).
create policy "관리자는 매니저 권한 전체 조회 가능"
  on public.manager_permissions for select
  using (is_admin());

create policy "매니저는 본인 권한만 조회 가능"
  on public.manager_permissions for select
  using (user_id = (select public.current_profile_id()));

-- =========================================================
-- 3. has_permission() — RLS와 앱 양쪽에서 쓰는 단일 판정 지점.
--    is_admin()과 같은 이유로 security definer + stable + search_path 고정.
--    ADMIN은 항상 true(루트), MANAGER는 박탈되지 않은 해당 칼럼이 true일 때만 true.
--    탈퇴자는 role이 남아 있어도 false(withdrawn_at 확인).
-- =========================================================
create or replace function public.has_permission(p_permission text)
returns boolean
language sql
security definer
set search_path = public
stable
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
    when p_permission = 'APPROVE_ENROLLMENTS' then exists (
      select 1 from public.users u
      join public.manager_permissions mp on mp.user_id = u.id
      where u.auth_user_id = auth.uid() and u.role = 'MANAGER' and u.withdrawn_at is null
        and mp.revoked_at is null and mp.can_approve_enrollments
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

-- =========================================================
-- 4. ADMIN은 SQL로만 — "규율이 아니라 구조적으로 불가능하게"
--    (forbid_users_hard_delete.sql과 같은 원칙, 2026-09-12 선례를 role에도 적용, 2026-09-18)
--    앱·API 경로(anon/authenticated/service_role)로는 role을 ADMIN으로 만들거나 바꿀 수 없다.
--    psql·Supabase Studio SQL 에디터(postgres 등 슈퍼유저)에서만 가능하다.
-- =========================================================
create or replace function public.users_guard_admin_role()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') then
    if tg_op = 'INSERT' and new.role = 'ADMIN' then
      raise exception 'ADMIN 역할은 애플리케이션에서 부여할 수 없습니다. DB에 SQL로 직접 설정하세요.'
        using errcode = 'insufficient_privilege';
    end if;

    if tg_op = 'UPDATE' and new.role is distinct from old.role
       and (new.role = 'ADMIN' or old.role = 'ADMIN') then
      raise exception 'ADMIN 역할은 애플리케이션에서 변경할 수 없습니다. DB에 SQL로 직접 변경하세요.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

create trigger users_guard_admin_role
  before insert or update of role on public.users
  for each row execute function public.users_guard_admin_role();

-- =========================================================
-- 5. complete_signup() 재정의 — p_role 파라미터를 없애고 항상 STUDENT로 가입시킨다.
--    반환 타입은 그대로 uuid이지만 파라미터 목록이 바뀌므로(개수 변경) 먼저 drop한다
--    (2026-09-12 선례와 같은 이유 — PostgREST는 이름/개수로 함수를 찾으므로, 옛 키로 호출하는
--    코드가 남아 있으면 조용히 틀리는 대신 요란하게 실패해야 한다. 호출처는
--    app/terms/actions.ts 한 곳이며 이번에 함께 고친다).
--    이 함수는 security definer라 위 4번 트리거의 current_user 검사(anon/authenticated/
--    service_role)를 통과하지 않는다 — 그래서 여기서는 트리거에 기대지 않고 role을 아예
--    파라미터로 받지 않는 방식으로 원천 차단한다.
-- =========================================================
drop function public.complete_signup(uuid, text, text, boolean, text, uuid, uuid);

create or replace function public.complete_signup(
  p_auth_user_id uuid,
  p_discord_id text,
  p_email text,
  p_email_verified boolean,
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
  insert into public.users (auth_user_id, discord_id, email, email_verified, role)
  values (p_auth_user_id, p_discord_id, p_email, p_email_verified, 'STUDENT')
  returning id into v_user_id;

  insert into public.terms_agreements (user_id, terms_id) values
    (v_user_id, p_service_terms_id),
    (v_user_id, p_privacy_terms_id);

  return v_user_id;
end;
$$;

-- =========================================================
-- 6. set_manager() / revoke_manager() — 매니저 승격·박탈을 한 트랜잭션으로.
--    security invoker(기본값)다 — service_role로 호출되면 current_user='service_role'이고,
--    role을 'MANAGER'/'STUDENT'로만 바꾸므로 4번 트리거(ADMIN 값만 막음)에 걸리지 않는다.
-- =========================================================
create or replace function public.set_manager(
  p_target uuid,
  p_actor uuid,
  p_view boolean,
  p_approve boolean,
  p_pay boolean
)
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
    (user_id, can_view_students, can_approve_enrollments, can_approve_payments, granted_by, revoked_at)
  values
    (p_target, p_view, p_approve, p_pay, p_actor, null)
  on conflict (user_id) do update set
    can_view_students = excluded.can_view_students,
    can_approve_enrollments = excluded.can_approve_enrollments,
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
      can_approve_enrollments = false,
      can_approve_payments = false,
      revoked_at = now()
  where user_id = p_target;
end;
$$;

-- =========================================================
-- 7. 민감한 함수의 실행 권한을 service_role로만 좁힌다(이 마이그레이션의 핵심 보안 조치).
--    Postgres 기본값(EXECUTE는 PUBLIC에 부여됨)을 명시적으로 거둔다. anon/authenticated도
--    함께 명시해 개별 GRANT가 남아 있을 가능성까지 방어한다(심층방어).
-- =========================================================
revoke execute on function public.complete_signup(uuid, text, text, boolean, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.apply_for_offering(uuid, uuid, uuid[])
  from public, anon, authenticated;
revoke execute on function public.record_payment_event(text, text, text, integer, text, text, uuid, uuid, text, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke execute on function public.consume_entitlement(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke execute on function public.reserve_course_offering_seat(uuid)
  from public, anon, authenticated;
revoke execute on function public.release_course_offering_seat(uuid)
  from public, anon, authenticated;
revoke execute on function public.set_manager(uuid, uuid, boolean, boolean, boolean)
  from public, anon, authenticated;
revoke execute on function public.revoke_manager(uuid)
  from public, anon, authenticated;

grant execute on function public.complete_signup(uuid, text, text, boolean, uuid, uuid) to service_role;
grant execute on function public.apply_for_offering(uuid, uuid, uuid[]) to service_role;
grant execute on function public.record_payment_event(text, text, text, integer, text, text, uuid, uuid, text, jsonb, jsonb, text) to service_role;
grant execute on function public.consume_entitlement(uuid, uuid, text, text) to service_role;
grant execute on function public.reserve_course_offering_seat(uuid) to service_role;
grant execute on function public.release_course_offering_seat(uuid) to service_role;
grant execute on function public.set_manager(uuid, uuid, boolean, boolean, boolean) to service_role;
grant execute on function public.revoke_manager(uuid) to service_role;

-- is_admin/current_profile_id/has_permission은 RLS 정책 평가 중 authenticated 세션으로
-- 호출돼야 하므로 그대로 둔다(실행 권한을 거두지 않는다).

-- =========================================================
-- 8. 조회 권한 확장 — 권한 있는 매니저는 수강생과 수강신청을 볼 수 있다.
--    전수조사 원칙: "조회도 차단 대상"이므로 기본은 계속 막혀 있고, 이 두 정책만 연다.
--    나머지 관리자 전용 테이블(payment_events, audit_logs, webhook_failures,
--    outbox_messages, entitlements, entitlement_uses, enrollment_events, courses 등 쓰기)은
--    is_admin()을 그대로 둬 매니저에게 열리지 않는다.
-- =========================================================
create policy "권한 있는 매니저는 수강생 조회 가능"
  on public.users for select
  using (
    role = 'STUDENT'
    and (public.has_permission('VIEW_STUDENTS') or public.has_permission('APPROVE_ENROLLMENTS'))
  );

create policy "권한 있는 매니저는 수강신청 조회 가능"
  on public.enrollments for select
  using (public.has_permission('VIEW_STUDENTS') or public.has_permission('APPROVE_ENROLLMENTS'));
