-- 인증된 디스코드 이메일로 우리 users.email을 바꿀 때, 직전 주소 하나를 남긴다.
-- 이력 테이블이 아니다. 같은 주소 재인증은 이 컬럼을 덮지 않는다(콜백이 담당).
-- 2026-09-15 수정하기로 한 것 B 보완.

alter table public.users
  add column previous_email text;
