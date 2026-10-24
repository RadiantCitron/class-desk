-- 약관 동의 기록은 한 번 남으면 바뀌거나 지워지면 안 된다.
-- order_events/payment_events에 이미 쓰는 범용 트리거 함수(20260921100000_audit_immutability.sql)를
-- 그대로 붙인다 — 새 함수를 만들지 않는다. anon/authenticated/service_role의 UPDATE·DELETE를
-- 막고, postgres(소유자)의 직접 작업만 통과시킨다.
create trigger terms_agreements_forbid_app_update_delete
  before update or delete on public.terms_agreements
  for each row execute function public.event_log_forbid_app_update_delete();
