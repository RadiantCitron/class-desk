-- 봉쇄(CLOSED)할 때 사유·행위자를 DB가 강제한다. 앱은 이미 둘 다
-- 채우고 있다(app/admin/system/actions.ts) — 코드 변경 없음, 방어선만 추가.
alter table public.system_gates add constraint system_gates_reason_required_when_closed
  check (status = 'OPEN' or reason is not null);
alter table public.system_gates add constraint system_gates_changed_by_required_when_closed
  check (status = 'OPEN' or changed_by is not null);
