-- 회원(users) 프로필 필드 보강.
-- 나이는 생년월일(birth_date)로 저장하고 화면에서 계산해 보여주는 걸 원칙으로 한다
-- (정수 나이를 그대로 저장하면 시간이 지나며 값이 stale해지는 안티패턴이라 채택하지 않음.
-- 참고).

alter table public.users
  add column name text,
  add column phone text,
  add column gender text check (gender in ('M', 'F', 'UNSPECIFIED')),
  add column birth_date date,
  add column note text;
