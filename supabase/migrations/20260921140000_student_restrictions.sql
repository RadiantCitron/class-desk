-- 수강생 권한 3계층 재정리(2026-09-21) 1단계: 개별 학생 3축 제한(VIEW/APPLY/PAYMENT)의
-- 기반 테이블. system_gates(전역, code 기준)와 개념적으로 대칭이지만 스코프가 다르다
-- (전역이 아니라 user_id별) — 억지로 통합하지 않고 형제 테이블로 신설한다.
--
-- 행 존재 여부가 곧 "그 축이 제한됐는가"다(primary key (user_id, scope)) — 해제는 행 DELETE.
-- 가입(SIGNUP) 축은 이번 범위에서 제외한다(재가입이 현재 기술적으로 불가능해 실효가 없음,
-- discord_id unique 제약 + 되살리는 코드 없음 — 참고).
create table public.student_restrictions (
  user_id uuid not null references public.users(id),
  scope text not null check (scope in ('VIEW', 'APPLY', 'PAYMENT')),
  reason text not null,
  restricted_by uuid not null references public.users(id),
  restricted_at timestamptz not null default now(),
  primary key (user_id, scope)
);

alter table public.student_restrictions enable row level security;

-- manager_permissions와 같은 원칙: insert/update/delete 정책은 두지 않는다 — 쓰기는
-- createAdminClient()로만 하고, RLS 기본 거부가 클라이언트발 쓰기를 원천 차단한다.
create policy "본인 제한 상태만 조회 가능"
  on public.student_restrictions for select
  using (user_id = (select public.current_profile_id()));

create policy "관리자는 전체 조회 가능"
  on public.student_restrictions for select
  using (is_admin());
