-- 디스코드 채팅방 입장 기능 4단계(2026-09-27) — discord_accounts는 RLS는 켜져 있지만
-- SELECT 정책이 하나도 없어서(2026-09-25 이용권DB이관.sql) 지금까지 anon/authenticated
-- 세션으로는 아무도 못 읽었다(service_role 전용). 지금까지는 이 테이블을 admin 클라이언트로만
-- 읽어서 드러나지 않았는데, lib/guards/checkout/context.ts가 학생 본인 세션으로 이 테이블을
-- 직접 읽게 되면서(users.discord_id를 대체) 반드시 필요해졌다 — 없으면 디스코드 연결 여부가
-- 항상 false로 오판돼 결제 자격검증이 깨진다. users 테이블의 기존 조회 정책 범위와 맞춘다
-- (20260912130000_decouple_auth_user_id.sql의 current_profile_id() 패턴,
-- 20260925090000_fix_users_manager_policy.sql의 매니저 권한 범위).

create policy "본인 디스코드 계정만 조회 가능"
  on public.discord_accounts for select
  using (user_id = (select public.current_profile_id()));

create policy "관리자는 전체 디스코드 계정 조회 가능"
  on public.discord_accounts for select
  using (public.is_admin());

create policy "권한 있는 매니저는 디스코드 계정 조회 가능"
  on public.discord_accounts for select
  using (public.has_permission('VIEW_STUDENTS') or public.has_permission('APPROVE_ORDERS'));
