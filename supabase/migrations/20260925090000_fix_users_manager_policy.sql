
-- =====================================================================
-- 기존 버그 수정 — 2026-09-23 개명 때 users 쪽 매니저 조회 정책만 옛 권한 이름
--    'APPROVE_ENROLLMENTS'로 남아, 승인 권한만 있는 매니저가 학생 행을 못 읽었다(has_permission()이 옛 이름을
--    모른다 — else false). orders 쪽 정책(20260923180000:244-247)과 같은 이름으로 다시 만든다.
-- =====================================================================
drop policy "권한 있는 매니저는 수강생 조회 가능" on public.users;
create policy "권한 있는 매니저는 수강생 조회 가능"
  on public.users for select
  using (
    role = 'STUDENT'
    and (public.has_permission('VIEW_STUDENTS') or public.has_permission('APPROVE_ORDERS'))
  );
