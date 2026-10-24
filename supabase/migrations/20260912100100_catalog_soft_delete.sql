-- "DB에서 삭제는 없다" 원칙을 카탈로그성 데이터(courses/course_offerings/discount_rules)까지
-- 확대 적용한다. 거래/이력 데이터(enrollments/payment_events/
-- terms_agreements 등)는 이미 append-only/소프트 탈퇴 원칙을 지키고 있었다 —
-- 이번은 지금까지 관리자 화면에서 실제 DELETE로 지워지던 설정성 데이터로 그 원칙을 넓히는 것.
--
-- 실제 삭제 대신 deleted_at만 세팅해 숨긴다. FK의 ON DELETE RESTRICT/SET NULL은 그대로
-- 남겨둔다(더 이상 이 경로로 실제 DELETE가 안 나가지만, 방어선을 하나 더 두는 셈이라 해가 없다).
-- 애플리케이션 레벨에서 "참조가 있으면 숨기지 못하게" 막는 것은 각 admin actions.ts가 담당한다
-- (기존 RESTRICT가 하던 일을 애플리케이션 코드로 옮긴 것 — soft delete는 DB 레벨 RESTRICT를
-- 트리거하지 않으므로).

alter table public.courses add column deleted_at timestamptz;
alter table public.course_offerings add column deleted_at timestamptz;
alter table public.discount_rules add column deleted_at timestamptz;

-- course_sessions(개설강의의 요일별 회차)는 순수 일정 메타데이터이지 역사적 기록이 아니다 —
-- 개설강의를 숨길 때 이 회차 행은 애플리케이션이 실제로 지워(app/admin/course-offerings/
-- actions.ts) 그 시간대를 다른 개설강의가 다시 쓸 수 있게 한다. 그래서 course_sessions
-- 자체엔 deleted_at을 추가하지 않고, EXCLUDE 제약(스케줄 겹침 방지)도 그대로 둔다 — "살아있는
-- 회차만 겹침을 막는다"는 의미가 자연히 유지된다.

-- apply_for_offering()의 2중 방어(모집기간/정원과 함께 이미 status='OPEN'을 확인하던 부분)에
-- deleted_at 확인을 추가한다 — 화면에서 숨긴 개설강의는 직접 URL로 접근해도(또는 API를 직접
-- 호출해도) 신청될 수 없어야 한다.
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
  select id, price into v_offering
  from public.course_offerings
  where id = p_offering_id
    and status = 'OPEN'
    and deleted_at is null
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
