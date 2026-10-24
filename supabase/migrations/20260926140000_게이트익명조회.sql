-- 가입 링크 요청은 로그인 전이라 auth.role()이 anon이다.
-- system_gates SELECT가 authenticated만 허용이면 loadGates()가 빈 결과를 fail-open으로
-- 읽어 SIGNUP 봉쇄가 가입 화면에 안 걸린다. 게이트 상태는 비밀이 아니다(배너용).

create policy "비로그인 사용자도 게이트 상태 조회 가능"
  on public.system_gates for select
  to anon
  using (true);
