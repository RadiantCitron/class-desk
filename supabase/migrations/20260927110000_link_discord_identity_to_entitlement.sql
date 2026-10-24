-- 디스코드 채팅방 입장 기능 2단계(2026-09-27) — link_discord_identity()의 소속을
-- MEMBER(users에 쓰기)에서 ENTITLEMENT(discord_accounts에 쓰기)로 옮긴다.
--
-- 배경: 디스코드는 더 이상 로그인/가입 수단이 아니다(2026-09-25부터 이메일 매직링크만).
-- users.discord_id는 옛 설계의 잔재이고, discord_accounts(이용권 모듈 소유, 20260925150200)와
-- 같은 값이 중복 저장돼 있었다. 이번 단계에서 이 함수가 discord_accounts에만 직접 쓰도록
-- 바꾸고, 그 결과 모듈 간 사실 전달이던 DISCORD_LINKED 아웃박스 토픽·record_discord_link()
-- 핸들러가 필요 없어져 함께 없앤다(같은 모듈이 됐으니 사실을 "전달"할 이유가 없다).
--
-- users.discord_id 컬럼 자체는 이번 단계에서 지우지 않는다 — 아직 이 컬럼을 읽는 코드가
-- 여러 화면에 남아 있어서, 그 코드를 discord_accounts로 옮긴 뒤(이후 단계) 마지막에 지운다.
-- 그래서 이 함수는 과도기 동안 잠시 users.discord_id도 같이 갱신해 두 값이 어긋나지 않게 한다
-- (users.discord_id를 지우는 마이그레이션에서 이 UPDATE 줄도 함께 제거할 것).

create or replace function public.link_discord_identity(p_user_id uuid, p_discord_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
begin
  select discord_id into v_current from public.discord_accounts where user_id = p_user_id for update;
  if v_current = p_discord_id then
    return; -- 같은 디스코드로 다시 연결 — 이미 기록돼 있다(멱등)
  end if;

  if v_current is not null then
    raise exception '이미 다른 디스코드 계정이 연결되어 있습니다. 관리자에게 문의해 주세요.';
  end if;

  -- discord_accounts.user_id의 FK(references users)가 "회원이 존재하는가"를 대신 검증한다
  -- (없는 회원이면 이 INSERT가 foreign_key_violation으로 실패) — users를 따로 SELECT해서
  -- 확인하면 이 함수(ENTITLEMENT 소유)가 users(MEMBER 소유)를 읽는 모듈 경계 위반이 된다
  -- (lib/architecture/boundaries.guard.test.ts가 SQL 함수 본문의 읽기까지 검사).
  insert into public.discord_accounts (user_id, discord_id)
  values (p_user_id, p_discord_id)
  on conflict (user_id) do update set discord_id = excluded.discord_id;

  -- 과도기: users.discord_id도 같이 갱신(이후 단계에서 컬럼을 지울 때 이 줄도 같이 뺀다).
  -- 위 INSERT가 이미 회원 존재를 검증했으므로 이 UPDATE는 실패할 일이 없다.
  update public.users set discord_id = p_discord_id where id = p_user_id;

  insert into public.account_events (user_id, event_type, actor, detail)
  values (p_user_id, 'IDENTITY_LINKED', 'SELF', jsonb_build_object('provider', 'discord'));
end;
$$;

drop function public.record_discord_link(uuid, text);

-- DISCORD_LINKED는 이제 더 안 쓴다(같은 모듈이 됐으니 사실을 전달할 필요가 없다). 다만
-- 과거에 이미 적재·처리된 행이 있을 수 있으니 users.discord_id를 지우듯 통째로 지우지 않고,
-- GRANT_ENTITLEMENTS/REVOKE_ENTITLEMENTS/SEND_EMAIL과 같은 방식(이미 처리된 것만 허용,
-- 새로 넣는 건 막음)으로 내린다.
alter table public.outbox_messages drop constraint outbox_messages_topic_check;
alter table public.outbox_messages
  add constraint outbox_messages_topic_check
    check (
      topic in ('PAYMENT_SUCCEEDED', 'PAYMENT_REFUNDED', 'ORDER_PAID', 'ORDER_REFUNDED', 'USER_WITHDRAWN')
      or (topic in ('GRANT_ENTITLEMENTS', 'REVOKE_ENTITLEMENTS', 'SEND_EMAIL', 'DISCORD_LINKED') and processed_at is not null)
    );
