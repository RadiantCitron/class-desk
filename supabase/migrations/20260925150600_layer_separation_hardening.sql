-- G단계 — 감사·시스템제약·역할권한 3단계 분리 보강.
-- ①(감사)·③(역할권한)은 이미 분리돼 있음을 확인했다(·19-5) — 이 마이그레이션은
-- ②(시스템제약)가 entitlement_uses·terms(빈틈 B, AP9)와 manager_permissions·student_restrictions
-- (빈틈 D, AP11) 자신을 못 지키던 부분만 닫는다.

-- 1) entitlement_uses·terms — 기존 원장 보호 함수를 재사용한다(새 함수 만들지 않음
--    원칙: 같은 등급의 원장은 같은 보호 수준을 쓴다).
create trigger entitlement_uses_forbid_app_update_delete
  before update or delete on public.entitlement_uses
  for each row execute function public.event_log_forbid_app_update_delete();

create trigger terms_forbid_app_update_delete
  before update or delete on public.terms
  for each row execute function public.event_log_forbid_app_update_delete();

-- 2) manager_permissions·student_restrictions — "행 하나=한 기간" 패턴이라 완전 append-only는
--    아니다. 막을 것은 ① DELETE(항상) ② 이미 닫힌 행(revoked_at/cleared_at이 있는 행)의 UPDATE뿐.
-- postgres 슈퍼유저는 예외(표 5번, 다른 원장들과 같은 예외 방식).

create function public.permission_history_forbid_delete()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'postgres' then
    return old;
  end if;
  raise exception '권한 이력 행은 삭제할 수 없습니다(해제·박탈은 UPDATE로 새 사유를 남깁니다). table=%, id=%',
    tg_table_name, old.id
    using errcode = 'restrict_violation';
end;
$$;

-- tg_table_name으로 분기하는 공용 함수는 안 된다 — old는 RECORD라, 실행되지 않는 분기라도
-- 그 테이블에 없는 컬럼(old.cleared_at을 manager_permissions 트리거에서 참조 등)을 적으면
-- PL/pgSQL이 파싱 단계에서 실패한다(begin/rollback 검증 중 실제로 발견, R-STOP 후 수정).
-- 테이블마다 함수를 따로 둔다.
create function public.manager_permissions_forbid_closed_update()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'postgres' then
    return new;
  end if;
  if old.revoked_at is not null then
    raise exception '이미 박탈된 매니저 권한 이력은 수정할 수 없습니다(재지정은 새 행으로). id=%', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create function public.student_restrictions_forbid_closed_update()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'postgres' then
    return new;
  end if;
  if old.cleared_at is not null then
    raise exception '이미 해제된 제한 이력은 수정할 수 없습니다(재지정은 새 행으로). id=%', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger manager_permissions_forbid_delete
  before delete on public.manager_permissions
  for each row execute function public.permission_history_forbid_delete();

create trigger manager_permissions_forbid_closed_update
  before update on public.manager_permissions
  for each row execute function public.manager_permissions_forbid_closed_update();

create trigger student_restrictions_forbid_delete
  before delete on public.student_restrictions
  for each row execute function public.permission_history_forbid_delete();

create trigger student_restrictions_forbid_closed_update
  before update on public.student_restrictions
  for each row execute function public.student_restrictions_forbid_closed_update();
