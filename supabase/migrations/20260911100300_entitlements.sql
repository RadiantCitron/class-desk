-- 결제 후처리(다운로드 권한/디스코드 입장권/수강 접근)를 각각 컬럼으로 흩어놓지 않고,
-- "결제의 대가로 받은 권한"이라는 공통 모델(entitlements)로 통합한다.
-- 구체적인 정책(다운로드 기간이 며칠인지, 몇 회까지인지 등)은 아직 미정이므로 지금은 틀만 만든다
-- (사용자 명시: "아직 결정된 건 없으니까 틀만 구현").

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete restrict,
  type text not null check (type in ('COURSE_ACCESS', 'SOURCE_DOWNLOAD', 'DISCORD_INVITE')),
  enrollment_id uuid references public.enrollments (id) on delete restrict,
  payment_event_id uuid references public.payment_events (id) on delete restrict,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  max_uses integer check (max_uses is null or max_uses > 0),
  revoked_at timestamptz,
  revoked_reason text,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.entitlements enable row level security;

create policy "본인 권한만 조회 가능"
  on public.entitlements for select
  using (auth.uid() = user_id);

create policy "관리자는 전체 권한 조회 가능"
  on public.entitlements for select
  using (is_admin());

-- insert/update(회수)는 서버(트랜잭션 함수/관리자 액션)가 service_role로만 수행한다.

create index on public.entitlements (user_id);
create index on public.entitlements (enrollment_id);

-- 권한 사용 이력(append-only). "다운로드했는지/몇 번 했는지"는 이 테이블의 행 개수로 답한다 —
-- 별도의 불린/카운터 컬럼을 두지 않는다(이 저장소가 이미 채택한 append-only 원칙과 동일).
create table public.entitlement_uses (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null references public.entitlements (id) on delete restrict,
  used_at timestamptz not null default now(),
  ip text,
  user_agent text
);

alter table public.entitlement_uses enable row level security;

create policy "본인 권한의 사용 이력만 조회 가능"
  on public.entitlement_uses for select
  using (exists (
    select 1 from public.entitlements ent
    where ent.id = entitlement_uses.entitlement_id and ent.user_id = auth.uid()
  ));

create policy "관리자는 전체 사용 이력 조회 가능"
  on public.entitlement_uses for select
  using (is_admin());

create index on public.entitlement_uses (entitlement_id);

-- 개설강의별로 결제 완료 시 어떤 권한을 얼마나 부여할지는 아직 정책이 없어 jsonb로 열어둔다.
-- 예: [{"type":"SOURCE_DOWNLOAD","days":365,"max_uses":5}]. 정책이 확정되면 전용 테이블로 승격한다.
alter table public.course_offerings
  add column grants jsonb not null default '[]'::jsonb;
