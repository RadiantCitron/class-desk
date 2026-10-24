-- 매니저 지정/박탈 이력을 보존한다. 지금은 PK가 user_id라
-- set_manager()가 "on conflict (user_id) do update ... revoked_at = null"로 과거 박탈 기록을
-- 덮어쓴다. 대리키(id)로 바꾸고, "지금 유효한 지정은 사람당 하나"는 부분 유니크 인덱스로 지킨다
-- (student_restrictions와 같은 패턴).
-- (의 SQL은 컬럼 이름 can_approve_enrollments·매개변수 순서가 옛것이다 — 실제 이름
-- can_approve_orders, set_manager(p_target, p_actor, p_view, p_approve, p_pay)를 쓴다. .)

alter table public.manager_permissions
  add column id uuid not null default gen_random_uuid(),
  add column revoked_reason text,
  add column revoked_by uuid references public.users (id) on delete restrict;

alter table public.manager_permissions drop constraint manager_permissions_pkey;
alter table public.manager_permissions add constraint manager_permissions_pkey primary key (id);

create unique index manager_permissions_active_uk
  on public.manager_permissions (user_id) where revoked_at is null;

alter table public.manager_permissions add constraint manager_permissions_revoked_reason_pair
  check ((revoked_at is null) = (revoked_reason is null));
alter table public.manager_permissions add constraint manager_permissions_revoked_by_pair
  check ((revoked_at is null) = (revoked_by is null));

-- set_manager — 매개변수는 그대로(create or replace로 권한 유지). 유효한 지정이 있으면 스위치만
-- 갱신하고, 없으면(최초 지정 또는 과거 박탈됨) 새 행을 추가한다 — 과거 박탈 행을 절대 덮어쓰지 않는다.
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

-- revoke_manager — 매개변수가 늘어나므로 drop 후 create(패턴 ①), 권한을 다시 잠근다(패턴 ②).
drop function public.revoke_manager(uuid);

create function public.revoke_manager(p_target uuid, p_reason text, p_actor uuid)
returns void
language plpgsql
as $$
declare
  v_role text;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '박탈 사유를 입력해야 합니다.';
  end if;

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
      revoked_at = now(),
      revoked_reason = p_reason,
      revoked_by = p_actor
  where user_id = p_target and revoked_at is null;
end;
$$;

revoke execute on function public.revoke_manager(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_manager(uuid, text, uuid)
  to service_role;
