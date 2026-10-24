-- =====================================================================
-- 폐강 철회 (revoke_course_offering_cancel)
-- 1. course_offering_events.event_type 에 'CANCEL_REVOKED' 추가
-- 2. revoke_course_offering_cancel RPC 함수 생성 (service_role 전용, DEFINER)
--    - CANCELLING 또는 CANCELLED 상태에서만 철회 가능
--    - ended_at 존재, ends_at(종강일) 경과, deleted_at 존재 시 거부
--    - p_target_status는 'OPEN' 또는 'CLOSED'만 허용
--    - course_offering_events에 CANCEL_REVOKED 이벤트 기록 (이전 상태, 처리된 신청 건수 요약)
-- =====================================================================

-- 1. 이벤트 종류에 CANCEL_REVOKED 추가
alter table public.course_offering_events drop constraint if exists course_offering_events_event_type_check;
alter table public.course_offering_events
  add constraint course_offering_events_event_type_check
    check (event_type in (
      'CREATED', 'UPDATED', 'STATUS_CHANGED', 'CANCEL_STARTED', 'CANCEL_COMPLETED',
      'ENDED', 'END_CANCELLED', 'DELETED', 'SESSION_ADDED', 'SESSION_CANCELLED', 'SCHEDULE_CHANGED',
      'SESSION_CORRECTED', 'MANUAL_CORRECTION', 'CANCEL_REVOKED'
    ));

-- 2. revoke_course_offering_cancel RPC 함수
create or replace function public.revoke_course_offering_cancel(
  p_offering_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_reason text,
  p_target_status text default 'CLOSED'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offering record;
  v_target text;
  v_refunded_count integer;
  v_closed_count integer;
  v_cancelled_count integer;
begin
  if p_actor_role is distinct from 'ADMIN' then
    raise exception '폐강 철회는 관리자만 할 수 있습니다.';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception '폐강 철회 사유를 입력해 주세요.';
  end if;

  v_target := coalesce(nullif(btrim(p_target_status), ''), 'CLOSED');
  if v_target not in ('OPEN', 'CLOSED') then
    raise exception '복귀 상태는 OPEN 또는 CLOSED만 가능합니다: %', v_target;
  end if;

  select id, status, ended_at, ends_at, deleted_at
    into v_offering
  from public.course_offerings
  where id = p_offering_id
  for update;

  if v_offering.id is null then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;

  if v_offering.deleted_at is not null then
    raise exception '삭제된 개설강의는 폐강 철회할 수 없습니다.';
  end if;

  if v_offering.ended_at is not null then
    raise exception '이미 종료된 개설강의는 폐강 철회할 수 없습니다.';
  end if;

  if v_offering.ends_at < now() then
    raise exception '종강일이 지난 개설강의는 폐강 철회할 수 없습니다.';
  end if;

  if v_offering.status not in ('CANCELLING', 'CANCELLED') then
    raise exception '폐강 진행 중(CANCELLING) 또는 폐강 완료(CANCELLED) 상태만 철회할 수 있습니다 (현재: %).', v_offering.status;
  end if;

  -- 처리된 신청 건수 요약 집계 (정보 보존용)
  select
    count(*) filter (where payment_status in ('REFUNDED', 'PARTIALLY_REFUNDED')),
    count(*) filter (where status = 'CANCELLED' and payment_status = 'PAID'),
    count(*) filter (where status = 'CANCELLED' and payment_status in ('UNPAID', 'PENDING'))
  into v_refunded_count, v_closed_count, v_cancelled_count
  from public.orders
  where course_offering_id = p_offering_id;

  -- 상태 변경
  update public.course_offerings
  set status = v_target,
      status_reason = btrim(p_reason),
      status_changed_by = p_actor_id,
      status_changed_at = clock_timestamp()
  where id = p_offering_id;

  -- 사건 원장 기록
  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason, before, after, created_at
  ) values (
    p_offering_id, 'CANCEL_REVOKED', 'ADMIN', p_actor_id, btrim(p_reason),
    jsonb_build_object('status', v_offering.status),
    jsonb_build_object(
      'status', v_target,
      'refunded_orders', coalesce(v_refunded_count, 0),
      'closed_orders', coalesce(v_closed_count, 0),
      'auto_cancelled_orders', coalesce(v_cancelled_count, 0)
    ),
    clock_timestamp()
  );
end;
$$;

revoke execute on function public.revoke_course_offering_cancel(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.revoke_course_offering_cancel(uuid, uuid, text, text, text)
  to service_role;
