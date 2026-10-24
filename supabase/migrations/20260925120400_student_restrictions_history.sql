-- 학생 제한 해제를 DELETE가 아니라 "해제 기록"으로. PK가
-- (user_id, scope)라 해제=행 삭제였고, 다시 걸면 이전 제한 이력이 사라졌다. 대리키(id) + 부분 유니크
-- ("지금 유효한 제한은 사람·축당 하나").
alter table public.student_restrictions
  add column id uuid not null default gen_random_uuid(),
  add column cleared_at timestamptz,
  add column cleared_reason text,
  add column cleared_by uuid references public.users (id) on delete restrict;

alter table public.student_restrictions drop constraint student_restrictions_pkey;
alter table public.student_restrictions add constraint student_restrictions_pkey primary key (id);

create unique index student_restrictions_active_uk
  on public.student_restrictions (user_id, scope) where cleared_at is null;

alter table public.student_restrictions add constraint student_restrictions_cleared_reason_pair
  check ((cleared_at is null) = (cleared_reason is null));
alter table public.student_restrictions add constraint student_restrictions_cleared_by_pair
  check ((cleared_at is null) = (cleared_by is null));
