-- users 테이블 RLS 정책의 무한 재귀 버그 수정.
-- 원인: "관리자는 전체 프로필 조회 가능" 정책이 users 테이블 자신을 다시 조회하는 조건이라
-- Postgres가 무한 재귀로 감지해 조회 자체를 거부함(에러 코드 42P17).
-- 실제 로그인 테스트 중 발견됨 (참고).
--
-- 해결: SECURITY DEFINER 함수로 role 확인을 감싼다. 이 함수는 테이블 소유자 권한으로
-- 실행되어 RLS를 우회하므로, 정책 안에서 안전하게 호출할 수 있다(재귀 없음).
-- 같은 패턴(관리자 전체 조회/쓰기)을 쓰던 다른 테이블 정책도 전부 이 함수로 통일한다.

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.users where id = auth.uid() and role = 'ADMIN'
  );
$$;

-- 1) users: 재귀의 직접 원인이었던 정책
drop policy "관리자는 전체 프로필 조회 가능" on public.users;
create policy "관리자는 전체 프로필 조회 가능"
  on public.users for select
  using (is_admin());

-- 2) courses
drop policy "관리자만 강의 등록/수정/삭제 가능" on public.courses;
create policy "관리자만 강의 등록/수정/삭제 가능"
  on public.courses for all
  using (is_admin())
  with check (is_admin());

-- 3) course_offerings
drop policy "관리자만 개설강의 등록/수정/삭제 가능" on public.course_offerings;
create policy "관리자만 개설강의 등록/수정/삭제 가능"
  on public.course_offerings for all
  using (is_admin())
  with check (is_admin());

-- 4) enrollment_events
drop policy "관리자는 전체 이벤트 조회 가능" on public.enrollment_events;
create policy "관리자는 전체 이벤트 조회 가능"
  on public.enrollment_events for select
  using (is_admin());

-- 5) enrollments
drop policy "관리자는 전체 신청 내역 조회 가능" on public.enrollments;
create policy "관리자는 전체 신청 내역 조회 가능"
  on public.enrollments for select
  using (is_admin());

-- 6) payment_events
drop policy "관리자는 전체 결제 이력 조회 가능" on public.payment_events;
create policy "관리자는 전체 결제 이력 조회 가능"
  on public.payment_events for select
  using (is_admin());

-- 7) webhook_failures
drop policy "관리자만 조회/처리 가능" on public.webhook_failures;
create policy "관리자만 조회/처리 가능"
  on public.webhook_failures for all
  using (is_admin())
  with check (is_admin());

-- 8) audit_logs
drop policy "관리자만 조회 가능" on public.audit_logs;
create policy "관리자만 조회 가능"
  on public.audit_logs for select
  using (is_admin());
