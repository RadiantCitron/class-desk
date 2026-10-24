-- 탈퇴 = 소프트 탈퇴, DB 행 삭제 절대 금지.
-- 행 삭제 대신 시각만 기록한다. proxy.ts가 이 값을 보고 즉시 로그아웃 처리한다.

alter table public.users
  add column withdrawn_at timestamptz;
