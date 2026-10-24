-- 개설강의·회차 테이블 직접 쓰기 차단 + 상태 전이·회차 불변 규칙을 DB에
-- 1. 브라우저 세션(anon, authenticated) 쓰기 RLS 삭제 및 권한 회수
-- 2. DB 트리거: 개설강의 상태 전이 순서 강제, 회차 삭제 금지, 회차 일정 불변, 회차 되살리기 금지

-- 1-1. RLS 정책 삭제 (관리자 직접 쓰기 정책 제거, 조회 정책은 유지)
drop policy if exists "관리자만 개설강의 등록/수정/삭제 가능" on public.course_offerings;
drop policy if exists "관리자만 회차 등록/수정/삭제 가능" on public.course_sessions;

-- 1-2. grant 회수: anon, authenticated의 직접 쓰기 권한 회수 (service_role은 유지)
revoke insert, update, delete, truncate on public.course_offerings, public.course_sessions from anon, authenticated;
grant select on public.course_offerings, public.course_sessions to anon, authenticated;

-- 2-1. 개설강의 상태 전이 순서 강제 트리거
create or replace function public.enforce_course_offering_status_edge()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') then
    if new.status is distinct from old.status then
      if not (
        (old.status = 'OPEN' and new.status = 'CLOSED') or
        (old.status = 'CLOSED' and new.status = 'OPEN') or
        (old.status in ('OPEN', 'CLOSED') and new.status = 'CANCELLING') or
        (old.status = 'CANCELLING' and new.status = 'CANCELLED')
      ) then
        raise exception '개설강의 상태를 %에서 %로 전이할 수 없습니다.', old.status, new.status
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger course_offerings_status_edge
  before update on public.course_offerings
  for each row execute function public.enforce_course_offering_status_edge();

revoke execute on function public.enforce_course_offering_status_edge() from public, anon, authenticated;

-- 2-2. 회차 불변 규칙 트리거 (삭제 금지, 날짜·시각·소속 수정 금지, 되살리기 금지)
create or replace function public.guard_course_session_immutable()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') then
    if tg_op = 'DELETE' then
      raise exception '회차 행은 삭제할 수 없습니다. 취소는 비활성화(deactivated_at)를 사용하십시오.'
        using errcode = 'restrict_violation';
    end if;

    if tg_op = 'UPDATE' then
      if new.session_date is distinct from old.session_date
         or new.start_time is distinct from old.start_time
         or new.end_time is distinct from old.end_time
         or new.course_offering_id is distinct from old.course_offering_id then
        raise exception '회차의 날짜·시각·소속 개설강의는 수정할 수 없습니다(취소 후 재추가 필요).'
          using errcode = 'restrict_violation';
      end if;

      if old.deactivated_at is not null and new.deactivated_at is null then
        raise exception '취소된 회차는 다시 활성화할 수 없습니다.'
          using errcode = 'restrict_violation';
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger course_sessions_no_delete
  before delete on public.course_sessions
  for each row execute function public.guard_course_session_immutable();

create trigger course_sessions_immutable_fields
  before update on public.course_sessions
  for each row execute function public.guard_course_session_immutable();

revoke execute on function public.guard_course_session_immutable() from public, anon, authenticated;
