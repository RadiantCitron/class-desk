-- 장애유형교차카탈로그.md 4-2 — reset_dead_outbox_message()가 attempts를 리셋하지 않아서,
-- 죽은 메시지를 관리자가 되살려도 사실상 "10번의 새 기회"가 아니라 "1번"이었다(attempts가
-- 이미 MAX_ATTEMPTS에 도달한 채였으므로, 재시도가 한 번만 더 실패해도 즉시 다시 죽는다).
-- "재시도" 버튼을 누르면 진짜로 새로 10번의 기회를 주도록 attempts도 0으로 되돌린다.

create or replace function public.reset_dead_outbox_message(p_outbox_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.outbox_messages
  set dead_at = null,
      attempts = 0,
      next_attempt_at = now()
  where id = p_outbox_message_id and dead_at is not null;

  if not found then
    raise exception '이미 처리됐거나 죽은 상태가 아닌 메시지입니다.';
  end if;
end;
$$;
