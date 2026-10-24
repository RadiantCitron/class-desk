-- 이용권 회수 시 사유를 DB가 강제한다. 유일한 회수 경로
-- (lib/entitlements/handlers.ts)가 이미 항상 사유를 채우므로 코드 변경은 없다 — 다른 경로가 실수로
-- 사유 없이 회수하는 것을 원천 차단하는 방어선이다. revoked_by는 두지 않는다(회수 행위자가 전부 시스템).
alter table public.entitlements add constraint entitlements_revoked_reason_pair
  check ((revoked_at is null) = (revoked_reason is null));
