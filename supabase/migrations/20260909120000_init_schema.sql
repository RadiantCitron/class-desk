-- class-desk 초기 스키마 (초안)
-- 설계 원칙: (이벤트소싱-lite), 7절(로그 분리) 참고.
-- 강의/수강생 세부 속성은 추후 정하므로, 여기서는 뼈대만 정의한다.
-- 이 마이그레이션은 초안이며, 실제 요구사항 확정 시 새 마이그레이션으로 보완한다(파일을 되돌려 고치지 않는다).

-- =========================================================
-- 0. 공용 함수: updated_at 자동 갱신
-- =========================================================
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =========================================================
-- 1. users: auth.users를 미러링하는 앱 전용 프로필 테이블
--    role은 애플리케이션(로그인 콜백)이 최초 1회 결정해 기록한다.
--
-- =========================================================
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  discord_id text not null unique,
  email text not null,
  email_verified boolean not null default false,
  role text not null default 'STUDENT' check (role in ('ADMIN', 'STUDENT')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger users_set_updated_at
  before update on public.users
  for each row execute function set_updated_at();

alter table public.users enable row level security;

create policy "본인 프로필만 조회 가능"
  on public.users for select
  using (auth.uid() = id);

create policy "관리자는 전체 프로필 조회 가능"
  on public.users for select
  using (exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'ADMIN'
  ));

-- =========================================================
-- 2. terms_agreements: 약관 동의 이력 (append-only, 삭제/수정 금지)
--    가입 시 약관 동의 없이는 가입 불가 — 애플리케이션에서 강제.
--
-- =========================================================
create table public.terms_agreements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete restrict,
  terms_version text not null,
  agreed_at timestamptz not null default now()
);

alter table public.terms_agreements enable row level security;

create policy "본인 동의 이력만 조회 가능"
  on public.terms_agreements for select
  using (auth.uid() = user_id);

create policy "본인 동의 이력만 등록 가능"
  on public.terms_agreements for insert
  with check (auth.uid() = user_id);

-- update/delete 정책을 만들지 않는다 = RLS 활성화 상태에서 수정/삭제 자체가 불가능.

-- =========================================================
-- 3. courses: 강의 (관리자 CRUD 대상)
-- =========================================================
create table public.courses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  capacity integer not null check (capacity >= 0),
  price integer not null check (price >= 0),
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger courses_set_updated_at
  before update on public.courses
  for each row execute function set_updated_at();

alter table public.courses enable row level security;

create policy "로그인한 사용자는 강의 목록 조회 가능"
  on public.courses for select
  using (auth.role() = 'authenticated');

create policy "관리자만 강의 등록/수정/삭제 가능"
  on public.courses for all
  using (exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'ADMIN'
  ))
  with check (exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'ADMIN'
  ));

-- =========================================================
-- 4. enrollment_events: 신청/승인/반려/취소/환불 등 상태 전이 이력
--    append-only. 관리자의 "수동 승인" 행위도 여기 기록된다.
-- =========================================================
create table public.enrollment_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete restrict,
  course_id uuid not null references public.courses (id) on delete restrict,
  event_type text not null check (
    event_type in ('APPLIED', 'APPROVED', 'REJECTED', 'CANCELLED', 'REFUNDED')
  ),
  -- 승인/반려처럼 사람이 개입한 이벤트만 actor_user_id를 채운다. 신청(APPLIED)은 웹훅이 남기므로 NULL.
  actor text not null check (actor in ('SYSTEM', 'ADMIN')),
  actor_user_id uuid references public.users (id),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.enrollment_events enable row level security;

create policy "본인 관련 이벤트만 조회 가능"
  on public.enrollment_events for select
  using (auth.uid() = user_id);

create policy "관리자는 전체 이벤트 조회 가능"
  on public.enrollment_events for select
  using (exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'ADMIN'
  ));

-- insert는 서버(webhook 핸들러/관리자 서버 액션)가 service_role로만 수행한다.
-- 클라이언트발 insert/update/delete 정책을 두지 않는다 = 클라이언트에서는 불가능.

-- =========================================================
-- 5. enrollments: 신청 현재 상태 요약 (조회 편의용 캐시)
--    enrollment_events에서 파생되는 값으로 취급한다.
-- =========================================================
create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete restrict,
  course_id uuid not null references public.courses (id) on delete restrict,
  status text not null default 'PENDING' check (
    status in ('PENDING', 'ENROLLED', 'REJECTED', 'CANCELLED', 'REFUNDED')
  ),
  payment_link text,
  applied_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, course_id)
);

create trigger enrollments_set_updated_at
  before update on public.enrollments
  for each row execute function set_updated_at();

alter table public.enrollments enable row level security;

create policy "본인 신청 내역만 조회 가능"
  on public.enrollments for select
  using (auth.uid() = user_id);

create policy "관리자는 전체 신청 내역 조회 가능"
  on public.enrollments for select
  using (exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'ADMIN'
  ));

-- =========================================================
-- 6. payment_events: 결제/환불 원장 (append-only, 페이앱 웹훅 전용 기록)
--    고유 거래번호로 멱등성을 보장한다.
-- =========================================================
create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments (id) on delete restrict,
  event_type text not null check (
    event_type in ('PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'REFUNDED')
  ),
  amount integer not null check (amount >= 0),
  payapp_transaction_id text not null unique,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.payment_events enable row level security;

create policy "본인 결제 이력만 조회 가능"
  on public.payment_events for select
  using (exists (
    select 1 from public.enrollments e
    where e.id = payment_events.enrollment_id and e.user_id = auth.uid()
  ));

create policy "관리자는 전체 결제 이력 조회 가능"
  on public.payment_events for select
  using (exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'ADMIN'
  ));

-- =========================================================
-- 7. webhook_failures: DLQ (Tally/페이앱 웹훅 처리 실패 보관소)
--    관리자 대시보드 경고등 + 수동 처리 화면의 데이터 소스.
-- =========================================================
create table public.webhook_failures (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('TALLY', 'PAYAPP')),
  payload jsonb not null,
  error_message text not null,
  resolved boolean not null default false,
  resolved_by uuid references public.users (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.webhook_failures enable row level security;

create policy "관리자만 조회/처리 가능"
  on public.webhook_failures for all
  using (exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'ADMIN'
  ))
  with check (exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'ADMIN'
  ));

-- =========================================================
-- 8. audit_logs: 관리자 행위 감사로그 (학생에게 노출하는 이력과 분리)
--
-- =========================================================
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references public.users (id),
  action text not null,
  target_table text not null,
  target_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_logs enable row level security;

create policy "관리자만 조회 가능"
  on public.audit_logs for select
  using (exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'ADMIN'
  ));

-- insert는 서버(관리자 서버 액션)가 service_role로만 수행한다.
