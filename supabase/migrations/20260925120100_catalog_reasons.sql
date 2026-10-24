-- 카탈로그 4종의 "비활성화(삭제)"와 "마감"에 사유·행위자를 강제한다.
-- 컬럼 이름은 기존 관용구(deleted_at)를 그대로 두고 짝 컬럼만 붙인다(이름이 아니라 패턴).
-- 행위자 FK는 on delete restrict — 사람 행이 지워져 기록이 조용히 끊기는 경로를 만들지 않는다.

alter table public.courses
  add column deleted_reason text,
  add column deleted_by uuid references public.users (id) on delete restrict;
alter table public.courses add constraint courses_deleted_reason_pair
  check ((deleted_at is null) = (deleted_reason is null));
alter table public.courses add constraint courses_deleted_by_pair
  check ((deleted_at is null) = (deleted_by is null));

alter table public.discount_rules
  add column deleted_reason text,
  add column deleted_by uuid references public.users (id) on delete restrict;
alter table public.discount_rules add constraint discount_rules_deleted_reason_pair
  check ((deleted_at is null) = (deleted_reason is null));
alter table public.discount_rules add constraint discount_rules_deleted_by_pair
  check ((deleted_at is null) = (deleted_by is null));

alter table public.course_offerings
  add column deleted_reason text,
  add column deleted_by uuid references public.users (id) on delete restrict,
  add column status_reason text,
  add column status_changed_by uuid references public.users (id) on delete restrict,
  add column status_changed_at timestamptz;
alter table public.course_offerings add constraint course_offerings_deleted_reason_pair
  check ((deleted_at is null) = (deleted_reason is null));
alter table public.course_offerings add constraint course_offerings_deleted_by_pair
  check ((deleted_at is null) = (deleted_by is null));
alter table public.course_offerings add constraint course_offerings_status_reason_required
  check (status = 'OPEN' or status_reason is not null);
alter table public.course_offerings add constraint course_offerings_status_changed_by_required
  check (status = 'OPEN' or status_changed_by is not null);

-- products는 아직 관리자 화면이 없다 — 스키마만 맞춰 둔다.
alter table public.products
  add column deleted_reason text,
  add column deleted_by uuid references public.users (id) on delete restrict,
  add column status_reason text,
  add column status_changed_by uuid references public.users (id) on delete restrict,
  add column status_changed_at timestamptz;
alter table public.products add constraint products_deleted_reason_pair
  check ((deleted_at is null) = (deleted_reason is null));
alter table public.products add constraint products_deleted_by_pair
  check ((deleted_at is null) = (deleted_by is null));
alter table public.products add constraint products_status_reason_required
  check (status = 'OPEN' or status_reason is not null);
alter table public.products add constraint products_status_changed_by_required
  check (status = 'OPEN' or status_changed_by is not null);
