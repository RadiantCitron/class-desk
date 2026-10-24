-- "규율이 아니라 구조적으로 불가능하게" — 회원 행 하드 삭제를
-- DB가 물리적으로 막는다. 소프트 탈퇴(users.withdrawn_at)만이 유일한 탈퇴 경로다
--

create or replace function public.forbid_users_delete()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception '회원 테이블(public.users)은 TRUNCATE할 수 없습니다.'
      using errcode = 'restrict_violation';
  end if;

  raise exception '회원 행은 삭제할 수 없습니다(소프트 탈퇴만 허용). id=%', old.id
    using errcode = 'restrict_violation',
          hint = '탈퇴는 users.withdrawn_at을 세팅하는 방식으로만 처리합니다(app/student/profile/actions.ts의 withdraw()).';
end;
$$;

create trigger users_forbid_delete
  before delete on public.users
  for each row execute function public.forbid_users_delete();

create trigger users_forbid_truncate
  before truncate on public.users
  for each statement execute function public.forbid_users_delete();

-- 보조 방어선(심층방어). 트리거가 주 방어선이고 이건 거들 뿐이다 — REVOKE만으로는
-- 테이블 소유자(postgres, 즉 docker exec psql이나 Studio SQL 에디터)를 막지 못하기 때문이다.
revoke delete, truncate on public.users from anon, authenticated, service_role;
