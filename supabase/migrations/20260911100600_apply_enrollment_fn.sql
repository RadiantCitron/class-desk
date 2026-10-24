-- 수강신청을 외부 폼(Tally)에서 사이트 내부 자체 폼으로 옮긴다.
-- Tally 웹훅은 비동기라 "좌석예약 실패 시 신청기록도 되돌리기"를 수동 보정(release_...)으로
-- 처리해야 했다(app/api/webhooks/tally/route.ts:113-129, 이번에 삭제됨). 자체 폼은 요청-응답이
-- 동기이므로 전부 하나의 DB 트랜잭션으로 묶을 수 있다 — complete_signup()과 같은 패턴.

create or replace function public.apply_for_offering(
  p_user_id uuid,
  p_offering_id uuid,
  p_terms_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offering record;
  v_reserved boolean;
  v_enrollment_id uuid;
begin
  -- 모집기간(opens_at~ends_at) 강제. status='OPEN'만 보고 기간을 안 봤던 게 기존 결함이었다
  -- (2026-09-11 결함 A — 관리자가 마감을 깜빡하면 강좌 종료 후에도 신청을 받았다).
  select id, price into v_offering
  from public.course_offerings
  where id = p_offering_id
    and status = 'OPEN'
    and now() >= opens_at
    and (ends_at is null or now() <= ends_at);

  if v_offering.id is null then
    raise exception '신청할 수 없는 개설강의입니다.';
  end if;

  select public.reserve_course_offering_seat(p_offering_id) into v_reserved;
  if not coalesce(v_reserved, false) then
    raise exception '정원이 마감되어 신청할 수 없습니다.';
  end if;

  begin
    insert into public.enrollments (user_id, course_offering_id, list_price, final_amount)
    values (p_user_id, p_offering_id, v_offering.price, v_offering.price)
    returning id into v_enrollment_id;
  exception when unique_violation then
    -- 이 분기는 catch로 트랜잭션을 계속 진행시키므로, 방금 차감한 좌석을 수동으로 되돌려야 한다.
    -- (그 외 예외는 잡지 않고 그대로 전파시켜 함수 전체가 자동 롤백되게 둔다 — 좌석 차감도 함께 되돌아감)
    perform public.release_course_offering_seat(p_offering_id);
    raise exception '이미 신청한 강의입니다.';
  end;

  insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, payload)
  values (p_user_id, p_offering_id, 'APPLIED', 'SYSTEM', '{}'::jsonb);

  if p_terms_id is not null then
    insert into public.terms_agreements (user_id, terms_id)
    values (p_user_id, p_terms_id);
  end if;

  return v_enrollment_id;
end;
$$;

-- 신뢰 경계: 클라이언트에서 직접 호출하지 않는다. app/student/apply/[offeringId]/actions.ts가
-- supabase.auth.getUser()로 세션 신원을 확인한 뒤 그 id를 p_user_id로 넘기고 service_role로 호출한다.
