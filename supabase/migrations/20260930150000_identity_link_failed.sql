-- 디스코드 연결 실패도 account_events에 append.
-- callback은 raw INSERT 금지, 이 RPC만 사용.

alter table public.account_events drop constraint account_events_event_type_check;
alter table public.account_events add constraint account_events_event_type_check
  check (event_type in (
    'SIGNED_UP',
    'IDENTITY_LINKED',
    'IDENTITY_LINK_FAILED',
    'WITHDRAWN',
    'REACTIVATED',
    'EMAIL_CHANGED'
  ));

create function public.record_identity_link_failed(p_user_id uuid, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.users where id = p_user_id) then
    raise exception '회원을 찾을 수 없습니다.';
  end if;

  insert into public.account_events (user_id, event_type, actor, detail)
  values (
    p_user_id,
    'IDENTITY_LINK_FAILED',
    'SELF',
    coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('provider', 'discord')
  );
end;
$$;

revoke execute on function public.record_identity_link_failed(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_identity_link_failed(uuid, jsonb)
  to service_role;
