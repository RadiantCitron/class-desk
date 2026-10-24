--  — 이메일 변경 동기화.
--
-- 문제: 학생이 Supabase 인증 이메일을 바꿔도(anon 키로 updateUser({email}) 가능) 우리 users.email은
-- 그대로였다. 그러면 탈퇴 확인(본인 이메일 재입력)·매니저 지정(이메일 조회)이 옛 이메일 기준으로
-- 동작하고, 나중에 그 옛 주소로 가입하려는 사람은 users_email_key 위반으로 영구히 막혔다.
--
-- 동기화 지점은 app/auth/confirm 한 곳뿐이다 — proxy.ts에서 요청마다 동기화하면
-- 읽기 경로에서 쓰기가 일어나는 안티패턴이기 때문이다. 이메일 변경은 double_confirm_changes = true라
-- 확인 링크를 눌러야만 끝나므로, 그 링크가 항상 /auth/confirm으로 돌아오게 만들면(config.toml의
-- email_change 템플릿, 다음 마이그레이션 아님 — config.toml 자체 변경) 동기화가 항상 이 한
-- 지점을 지난다. 로그인할 때도 같은 비교를 해서 놓친 경우를 보정한다.

alter table public.account_events drop constraint account_events_event_type_check;
alter table public.account_events add constraint account_events_event_type_check
  check (event_type in ('SIGNED_UP', 'IDENTITY_LINKED', 'WITHDRAWN', 'REACTIVATED', 'EMAIL_CHANGED'));

create function public.sync_my_email()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_old_email text;
  v_new_email text;
begin
  -- 클라이언트 입력을 받지 않는다 — 세션(auth.uid())에서만 새 이메일을 읽는다(남의 이메일을
  -- 대신 동기화시키는 경로를 원천 차단).
  select id, email into v_user_id, v_old_email
  from public.users
  where auth_user_id = auth.uid();

  if v_user_id is null then
    return; -- 아직 우리 회원 행이 없는 상태(가입 마무리 전) — 할 일 없음.
  end if;

  select email into v_new_email from auth.users where id = auth.uid();

  if v_new_email is null or v_new_email = v_old_email then
    return; -- 변경 없음.
  end if;

  update public.users set email = v_new_email where id = v_user_id;

  insert into public.account_events (user_id, event_type, actor, detail)
  values (v_user_id, 'EMAIL_CHANGED', 'SELF', jsonb_build_object('from', v_old_email, 'to', v_new_email));
exception
  when unique_violation then
    -- 새 이메일이 이미 다른 회원 행의 이메일과 겹친다(둘 다 우리 users를 갖고 있었던 드문 경우).
    -- 인증 이메일은 이미 Supabase 쪽에서 바뀌었으므로 되돌릴 수 없다 — 관리자가 볼 수 있게 DLQ에
    -- 남기고 조용히 끝낸다(요청을 막지 않는다, fail-open — lib/audit의 원칙과 동일).
    insert into public.dead_letters (source, payload, error_message)
    values (
      'INTERNAL',
      jsonb_build_object('handler', 'sync_my_email', 'user_id', v_user_id),
      '이메일 동기화 실패(이미 사용 중인 이메일) — user_id=' || v_user_id::text
        || ', from=' || coalesce(v_old_email, 'null') || ', to=' || coalesce(v_new_email, 'null')
    );
end;
$$;

revoke execute on function public.sync_my_email()
  from public, anon;
grant execute on function public.sync_my_email()
  to authenticated;
