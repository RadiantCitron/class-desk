-- =====================================================================
-- 무결성 잔여 보강 — 일정 변경 안내 메일 발송 사실 기록
-- 1. order_events.event_type 에 SCHEDULE_CHANGE_NOTICE_EMAILED 추가
-- 2. record_schedule_change_email_sent RPC 신설 (ORDER 모듈, service_role 전용)
-- =====================================================================

-- 1. order_events 이벤트 종류에 SCHEDULE_CHANGE_NOTICE_EMAILED 추가
alter table public.order_events drop constraint if exists order_events_event_type_check;
alter table public.order_events
  add constraint order_events_event_type_check
    check (event_type = any (array[
      'APPLIED', 'APPROVED', 'REJECTED', 'CANCELLED', 'ACCESS_GRANTED', 'CLOSED', 'REFUND_REQUESTED', 'REFUND_REQUEST_REJECTED',
      'SCHEDULE_CHANGE_NOTICE', 'SCHEDULE_CHANGE_ACCEPTED', 'SCHEDULE_CHANGE_DECLINED',
      'REFUND_APPLIED',
      'GRANTS_REISSUED', 'NO_REFUND_DECIDED',
      'SCHEDULE_CHANGE_NOTICE_EMAILED'
    ]));

-- 2. record_schedule_change_email_sent: 일정 변경 안내 메일 발송 성공 사실을 원장에 기록
--   - p_order_id: 대상 주문
--   - p_notice_event_id: 대응하는 SCHEDULE_CHANGE_NOTICE 사건 id
--   - 멱등성: 동일 notice_event_id에 대한 중복 발송 기록 방지 (이미 있으면 기존 id 반환)
create or replace function public.record_schedule_change_email_sent(
  p_order_id uuid,
  p_notice_event_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_id uuid;
  v_new_id uuid;
  v_notice_exists boolean;
begin
  if p_order_id is null or p_notice_event_id is null then
    raise exception '주문 id와 안내 사건 id가 필요합니다.';
  end if;

  -- 대응하는 안내 사건이 존재하는지 확인
  select exists (
    select 1 from public.order_events
    where id = p_notice_event_id
      and order_id = p_order_id
      and event_type = 'SCHEDULE_CHANGE_NOTICE'
  ) into v_notice_exists;

  if not v_notice_exists then
    raise exception '해당 주문의 일정 변경 안내 사건을 찾을 수 없습니다.';
  end if;

  -- 멱등성: 이미 해당 notice에 대한 발송 완료 사건이 있으면 기존 id 반환
  select id into v_existing_id
  from public.order_events
  where order_id = p_order_id
    and event_type = 'SCHEDULE_CHANGE_NOTICE_EMAILED'
    and (payload ->> 'notice_event_id') = p_notice_event_id::text
  limit 1;

  if v_existing_id is not null then
    return v_existing_id;
  end if;

  insert into public.order_events (
    order_id,
    event_type,
    actor,
    payload
  ) values (
    p_order_id,
    'SCHEDULE_CHANGE_NOTICE_EMAILED',
    'SYSTEM',
    jsonb_build_object(
      'notice_event_id', p_notice_event_id,
      'recorded_at', clock_timestamp()
    )
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke all on function public.record_schedule_change_email_sent(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_schedule_change_email_sent(uuid, uuid) to service_role;
