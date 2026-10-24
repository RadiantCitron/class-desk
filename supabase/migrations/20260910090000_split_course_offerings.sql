-- 강의(courses, 과목 템플릿) / 개설강의(course_offerings, 실행 인스턴스) 분리.
-- 배경: "강의와 개설강의는 별개다" 논의 참고. 기존 courses 테이블이
-- 사실상 "개설강의"였다 — 여기서 courses를 템플릿으로 축소하고 course_offerings를 새로 만든다.
-- 이 저장소는 아직 실서비스 데이터가 없는 개발 초기 단계라 파괴적 컬럼 이동을 안전하게 수행한다.
-- (이후로는 마이그레이션 파일을 append-only로 유지 — 이 파일도 되돌려 고치지 않는다.)

-- =========================================================
-- 1. courses: 순수 템플릿으로 축소, category(강의종류) 추가
-- =========================================================
alter table public.courses
  drop column capacity,
  drop column price,
  drop column status;

alter table public.courses
  add column category text;

-- =========================================================
-- 2. course_offerings: 개설강의 (실행 인스턴스)
-- =========================================================
create table public.course_offerings (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete restrict,
  label text, -- 회차 별칭 (예: "1기", "2026년 3월반"). 선택 항목.
  capacity integer not null check (capacity >= 0),
  price integer not null check (price >= 0),
  location text, -- 위치 (디스코드 채널 링크 등)
  is_one_time boolean not null default false, -- 1회성 여부
  opens_at timestamptz not null default now(), -- 강의 개설(모집 시작) 일시
  ends_at timestamptz, -- 강좌 종료일시
  session_start_time time, -- 회차별 시작 시각 (반복 세션의 경우)
  session_end_time time, -- 회차별 종료 시각
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger course_offerings_set_updated_at
  before update on public.course_offerings
  for each row execute function set_updated_at();

alter table public.course_offerings enable row level security;

create policy "로그인한 사용자는 개설강의 조회 가능"
  on public.course_offerings for select
  using (auth.role() = 'authenticated');

create policy "관리자만 개설강의 등록/수정/삭제 가능"
  on public.course_offerings for all
  using (exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'ADMIN'
  ))
  with check (exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'ADMIN'
  ));

-- =========================================================
-- 3. enrollments / enrollment_events: course_id -> course_offering_id
-- =========================================================
alter table public.enrollments
  drop constraint enrollments_course_id_fkey,
  drop constraint enrollments_user_id_course_id_key;

alter table public.enrollments
  rename column course_id to course_offering_id;

alter table public.enrollments
  add constraint enrollments_course_offering_id_fkey
    foreign key (course_offering_id) references public.course_offerings (id) on delete restrict,
  add constraint enrollments_user_id_course_offering_id_key
    unique (user_id, course_offering_id);

alter table public.enrollment_events
  drop constraint enrollment_events_course_id_fkey;

alter table public.enrollment_events
  rename column course_id to course_offering_id;

alter table public.enrollment_events
  add constraint enrollment_events_course_offering_id_fkey
    foreign key (course_offering_id) references public.course_offerings (id) on delete restrict;
