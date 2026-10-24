-- 감사 모듈 재설계 2단계: audit_logs/enrollment_events/payment_events를 위변조(UPDATE/DELETE)로부터
-- 구조적으로 보호하고, 검색성을 위한 인덱스를 추가한다.
-- 선례: forbid_users_hard_delete.sql, 20260920100000_system_gates.sql의 system_gates_forbid_insert_delete.

-- =========================================================
-- 1. audit_logs — 누구도 UPDATE/DELETE 못 한다 (INSERT는 서비스가 계속 자유롭게 해야 하므로 그대로 둔다)
-- =========================================================
create function public.audit_logs_forbid_update_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception '감사로그는 수정·삭제할 수 없습니다(append-only). 잘못된 기록은 새 행을 추가해 바로잡으세요.'
    using errcode = 'restrict_violation';
end;
$$;

create trigger audit_logs_forbid_update
  before update on public.audit_logs
  for each row execute function public.audit_logs_forbid_update_delete();

create trigger audit_logs_forbid_delete
  before delete on public.audit_logs
  for each row execute function public.audit_logs_forbid_update_delete();

-- REVOKE만으로는 테이블 소유자(postgres)를 막지 못하므로 트리거가 주 방어선이다
-- (forbid_users_hard_delete.sql과 동일 원칙). service_role도 예외 없이 막는다 — 감사로그를
-- "고쳐야 할" 정당한 서버 로직은 없어야 한다.
revoke update, delete, truncate on public.audit_logs from anon, authenticated, service_role;

-- =========================================================
-- 2. enrollment_events / payment_events — 같은 보호, 단 소유자(postgres) 직접 작업 여지는 남긴다
-- =========================================================
-- users_guard_admin_role()과 같은 조건부 방식: 앱 경로(anon/authenticated/service_role)는
-- 막되, current_user가 postgres(psql/Studio로 소유자가 직접 작업하는 경우, 예: 과거 백필
-- 마이그레이션 20260911100200 같은 것)는 통과시킨다.
create function public.event_log_forbid_app_update_delete()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') then
    raise exception '이력 기록은 수정·삭제할 수 없습니다(append-only).'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger enrollment_events_forbid_app_update_delete
  before update or delete on public.enrollment_events
  for each row execute function public.event_log_forbid_app_update_delete();

create trigger payment_events_forbid_app_update_delete
  before update or delete on public.payment_events
  for each row execute function public.event_log_forbid_app_update_delete();

-- =========================================================
-- 3. 검색성 — audit_logs 인덱스 4개(기존 0개)
-- =========================================================
create index audit_logs_created_at_idx on public.audit_logs (created_at desc);
create index audit_logs_actor_created_idx on public.audit_logs (actor_user_id, created_at desc);
create index audit_logs_target_idx on public.audit_logs (target_table, target_id);
-- 끊긴 시도(결과 행 없는 ATTEMPTED) 탐지 전용 부분 인덱스 — 전체 스캔 없이 바로 찾는다.
create index audit_logs_attempted_idx on public.audit_logs (created_at)
  where phase = 'ATTEMPTED';
