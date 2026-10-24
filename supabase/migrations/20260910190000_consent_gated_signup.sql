-- "가입은 약관 동의를 근거로 판단한다" — 디스코드 인증(신원 확인)은 항상 먼저 일어나지만,
-- public.users 행(=이 시스템에서의 "가입")은 이제 약관 동의와 **함께, 원자적으로만** 생성된다.
--
--
-- 계정 생성과 동의 기록, 이 두 insert를 애플리케이션 코드에서 순차적으로 따로 실행하면
-- 중간에 실패했을 때 "동의 없이 계정만 존재"하는 상태가 생길 수 있다(실제로 기존 테스트
-- 계정이 이 상태였다 — 참고). 이를 DB 트랜잭션 하나로 묶어 원천적으로 불가능하게
-- 만든다. 기존 reserve_course_offering_seat()/is_admin()과 같은 패턴이다.
create or replace function public.complete_signup(
  p_user_id uuid,
  p_discord_id text,
  p_email text,
  p_email_verified boolean,
  p_role text,
  p_terms_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, discord_id, email, email_verified, role)
  values (p_user_id, p_discord_id, p_email, p_email_verified, p_role);

  insert into public.terms_agreements (user_id, terms_id)
  values (p_user_id, p_terms_id);
end;
$$;

-- 신뢰 경계: 이 함수는 클라이언트에서 직접 호출하지 않는다. service_role(서버 전용 관리자
-- 클라이언트)로만 호출하며, 호출 전 Next.js 서버 코드(app/terms/actions.ts)가 반드시
-- supabase.auth.getUser()로 세션 신원을 확인한 뒤 그 id를 p_user_id로 넘긴다.
-- requireAdmin()/runAdminCommand()(lib/supabase/audit.ts)와 동일한 신뢰 경계다.
