-- 개설 후 회차 추가·취소.
--
--  · S-1은 개설 후 일정을 고칠 방법을 만들지 않았다. 이 파일이 회차를 하나씩 추가(add_course_session)하거나 취소(cancel_course_session:
--    비활성 + 사유, 삭제 없음)하는 두 함수를 만든다. 시각·날짜를 바꾸는 것 = 취소 + 추가.
--  · 허용 조건(둘 다 assert_course_sessions_editable이 검사): 삭제·폐강·종료되지 않은 개설강의, **개강 전**(opens_at > now()),
--    **살아 있는 신청(PENDING/APPROVED)이 없을 것**, 사유 필수. 개강 후/신청자가 있는 수업의 일정 변경은 안내·동의가 필요한
--    S-6의 몫이다. (개강 후 첫 회차를 취소하면 계산 캐시 opens_at이 뒤로 밀려 이미 시작한 수업의 신청이 다시 열리므로 막는다.)
--  · 개강·종료는 S-1의 트리거가 다시 계산한다. 마지막 활성 회차는 S-1의 트리거가 비활성화를 거부한다.
--  · SECURITY INVOKER(관리자 세션의 RLS가 쓰기를 막는다 — create/update_course_offering과 같은 패턴). grant는 같은 파일.

create function public.assert_course_sessions_editable(p_offering_id uuid, p_actor uuid, p_reason text)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_off public.course_offerings%rowtype;
begin
  if p_actor is null then
    raise exception '행위자가 필요합니다.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '사유를 입력해야 합니다.';
  end if;

  select * into v_off from public.course_offerings where id = p_offering_id for update;
  if not found then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_off.deleted_at is not null then
    raise exception '삭제된 개설강의의 일정은 바꿀 수 없습니다.';
  end if;
  if v_off.status not in ('OPEN', 'CLOSED') then
    raise exception '폐강된 개설강의의 일정은 바꿀 수 없습니다.';
  end if;
  if v_off.ended_at is not null then
    raise exception '종료된 개설강의의 일정은 바꿀 수 없습니다.';
  end if;
  if v_off.opens_at <= now() then
    raise exception '개강한 수업의 일정은 바꿀 수 없습니다.';
  end if;
  if exists (
    select 1 from public.orders o
    where o.course_offering_id = p_offering_id and o.status in ('PENDING', 'APPROVED')
  ) then
    raise exception '신청(승인 대기·승인됨)이 있는 수업의 일정 변경은 아직 지원하지 않습니다. 신청자 안내·동의 기능이 필요합니다.';
  end if;
end;
$$;

create function public.add_course_session(
  p_offering_id uuid,
  p_actor uuid,
  p_reason text,
  p_date date,
  p_start time,
  p_end time
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_date is null or p_start is null or p_end is null then
    raise exception '날짜와 시작·종료 시각이 필요합니다.';
  end if;
  if p_end <= p_start then
    raise exception '종료 시각은 시작 시각보다 늦어야 합니다.';
  end if;

  perform public.assert_course_sessions_editable(p_offering_id, p_actor, p_reason);

  begin
    insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
    values (p_offering_id, p_date, p_start, p_end)
    returning id into v_id;
  exception when check_violation then
    if sqlerrm like '%course_offerings_recruit_before_opens%' then
      raise exception '모집 시작은 개강(첫 회차 시작)보다 앞이어야 합니다.';
    end if;
    raise;
  end;

  return v_id;
end;
$$;

create function public.cancel_course_session(p_session_id uuid, p_actor uuid, p_reason text)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_offering_id uuid;
  v_deactivated timestamptz;
begin
  select course_offering_id, deactivated_at into v_offering_id, v_deactivated
  from public.course_sessions where id = p_session_id;
  if not found then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  perform public.assert_course_sessions_editable(v_offering_id, p_actor, p_reason);

  select deactivated_at into v_deactivated from public.course_sessions where id = p_session_id;
  if v_deactivated is not null then
    raise exception '이미 취소된 회차입니다.';
  end if;

  update public.course_sessions
  set deactivated_at = now(),
      deactivated_reason = btrim(p_reason)
  where id = p_session_id;
end;
$$;

revoke execute on function public.assert_course_sessions_editable(uuid, uuid, text) from public, anon;
grant execute on function public.assert_course_sessions_editable(uuid, uuid, text) to authenticated, service_role;
revoke execute on function public.add_course_session(uuid, uuid, text, date, time, time) from public, anon;
grant execute on function public.add_course_session(uuid, uuid, text, date, time, time) to authenticated, service_role;
revoke execute on function public.cancel_course_session(uuid, uuid, text) from public, anon;
grant execute on function public.cancel_course_session(uuid, uuid, text) to authenticated, service_role;
