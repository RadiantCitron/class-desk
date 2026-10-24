-- 데이터 무결성 보강 1/2: 강사 스케줄 겹침을 DB 차원에서 원천 차단 + 정원 초과를 DB 차원에서 원천 차단.
--
-- 배경: course_offerings.session_start_time/session_end_time(요일 정보 없는 단순 시각)만으로는
-- "화/목 20-22시"와 "수/금 20-22시"를 DB가 구분할 방법이 없어 겹침 판정 자체가 불가능했다.
-- 이 문제를 풀려면 요일(day_of_week) 정보가 있는 course_sessions(개설강의의 요일별 회차) 테이블이
-- 반드시 필요하다 — 의 YAGNI 유보 결정을 다시 여는 것이므로 여기 명시적으로 남긴다.

create extension if not exists btree_gist;

-- Postgres에 내장 range 타입이 없는 time에 대해 커스텀 range 타입을 만든다(국룰 패턴).
create type public.timerange as range (subtype = time);

create table public.course_sessions (
  id uuid primary key default gen_random_uuid(),
  course_offering_id uuid not null references public.course_offerings (id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6), -- 0=일요일 ... 6=토요일
  start_time time not null,
  end_time time not null check (end_time > start_time),
  valid_from date not null,  -- course_offerings.opens_at 날짜를 미러링(제약 계산용)
  valid_until date not null check (valid_until >= valid_from), -- course_offerings.ends_at 날짜를 미러링
  created_at timestamptz not null default now(),

  -- 같은 요일 + 겹치는 시간대 + 겹치는 기간인 두 회차는 INSERT/UPDATE 자체가 거부된다.
  -- 강사가 1인이라는 전제로 별도 파티션 키 없이 전역으로 겹침을 막는다.
  exclude using gist (
    day_of_week with =,
    public.timerange(start_time, end_time) with &&,
    daterange(valid_from, valid_until, '[]') with &&
  )
);

alter table public.course_sessions enable row level security;

create policy "로그인한 사용자는 회차 조회 가능"
  on public.course_sessions for select
  using (auth.role() = 'authenticated');

create policy "관리자만 회차 등록/수정/삭제 가능"
  on public.course_sessions for all
  using (is_admin())
  with check (is_admin());

create index on public.course_sessions (course_offering_id);

-- 정원(capacity, 불변 스냅샷) / 잔여석(remaining_seats, 원자적 차감 대상) 분리.
-- "재고 차감" 패턴 — remaining_seats는 CHECK로 0 미만/capacity 초과가 물리적으로 불가능하다.
alter table public.course_offerings
  add column remaining_seats integer,
  drop column session_start_time,
  drop column session_end_time;

update public.course_offerings set remaining_seats = capacity where remaining_seats is null;

alter table public.course_offerings
  alter column remaining_seats set not null,
  add constraint course_offerings_remaining_seats_range
    check (remaining_seats >= 0 and remaining_seats <= capacity);

create index on public.course_offerings (course_id);

-- 좌석 예약/반환을 원자적으로 수행하는 함수. supabase-js는 "컬럼 = 컬럼 - 1"식 원자적 UPDATE를
-- 직접 표현할 수 없어(RPC로만 가능), 동시 신청 경쟁 상황에서도 정원 초과가 나지 않도록
-- 반드시 이 함수를 통해서만 remaining_seats를 변경하게 한다.
create or replace function public.reserve_course_offering_seat(p_offering_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.course_offerings
  set remaining_seats = remaining_seats - 1
  where id = p_offering_id and remaining_seats > 0
  returning true;
$$;

create or replace function public.release_course_offering_seat(p_offering_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.course_offerings
  set remaining_seats = remaining_seats + 1
  where id = p_offering_id and remaining_seats < capacity;
$$;
