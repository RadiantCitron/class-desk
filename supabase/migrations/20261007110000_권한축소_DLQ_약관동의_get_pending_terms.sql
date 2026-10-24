-- 최소 권한 원칙(Principle of Least Privilege)에 따른 테이블 및 컬럼 권한 축소:
-- RLS 정책은 그대로 두고, 그 앞단의 테이블·컬럼 권한(GRANT)으로 "할 수 있는 동작" 자체를 좁힌다.
-- service_role(서버 코드)·DEFINER 함수는 영향 없다.

-- =====================================================================
-- O-01. dead_letters(장애·불일치 증거) — 관리자 세션은 조회와 "해결 처리"만
-- =====================================================================
-- 예전: 정책 "관리자만 조회/처리 가능"(for all, 20260910120000)과 Supabase 기본 GRANT 때문에 관리자 JWT로 증거를
-- 삭제하거나, 가짜 행을 넣거나(on_payment_succeeded 멱등 확인을 속일 수 있음), payload·오류문을 고칠 수 있었다(임시 DB 실측).
-- 앱의 세션 쓰기는 app/admin/dlq/actions.ts의 해결 처리(resolved·resolved_by·resolved_at·resolution_reason) 한 곳뿐이다.
-- 적재는 전부 service_role·DEFINER 함수가 한다.
revoke insert, update, delete, truncate on public.dead_letters from anon, authenticated;
revoke select on public.dead_letters from anon;
grant update (resolved, resolved_by, resolved_at, resolution_reason) on public.dead_letters to authenticated;

-- 해결된 증거는 앱 세션에서 다시 고칠 수 없다(해결 취소·사유 덮어쓰기 금지). manager_permissions의 "닫힌 행 동결"과 같은 방식.
create or replace function public.dead_letters_freeze_resolved()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.resolved and current_user in ('anon', 'authenticated') then
    raise exception '이미 해결 처리된 기록은 수정할 수 없습니다.';
  end if;
  return new;
end;
$$;

drop trigger if exists dead_letters_freeze_resolved on public.dead_letters;
create trigger dead_letters_freeze_resolved
  before update on public.dead_letters
  for each row execute function public.dead_letters_freeze_resolved();

-- =====================================================================
-- O-02. terms_agreements(동의 증거) — 학생 세션은 "누가·어느 약관" 두 칸만 넣을 수 있다
-- =====================================================================
-- 예전: INSERT 정책의 WITH CHECK가 user_id만 봐서, 학생이 agreed_at을 과거로 넣거나 남의 order_id에 동의를 묶을 수 있었다(실측).
-- 앱의 세션 INSERT(app/terms/actions.ts, app/student/profile/actions.ts, app/student/welcome/actions.ts)는 user_id·terms_id만 쓴다.
-- agreed_at은 default now(), order_id는 null — 주문에 묶인 동의는 create_order(DEFINER) 안에서만 생긴다.
revoke insert, update, delete, truncate on public.terms_agreements from anon, authenticated;
revoke select on public.terms_agreements from anon;
grant insert (user_id, terms_id) on public.terms_agreements to authenticated;

-- =====================================================================
-- O-03. get_pending_terms — service_role 전용(다른 DEFINER 함수와 같은 규칙)
-- =====================================================================
-- 예전: grant만 있고 revoke가 없어 anon이 /rpc/get_pending_terms로 아무 회원의 미동의 약관을 조회할 수 있었다(실측).
-- 호출처는 lib/supabase/identity.ts(service_role) 한 곳이다.
revoke execute on function public.get_pending_terms(uuid) from public, anon, authenticated;
grant execute on function public.get_pending_terms(uuid) to service_role;
