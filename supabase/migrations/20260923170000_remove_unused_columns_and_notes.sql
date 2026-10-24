-- DB 구조 재정립 3단계(2026-09-23 G7·D8) — 불필요한 것 제거.
-- 이 단계는 유일하게 되돌릴 수 없는 단계라,
-- 값이 있는 행이 하나라도 있으면 마이그레이션을 중단하는 안전장치를 전부에 둔다.
--
-- 주의: 계획에는 "도달할 수 없는 중복 방어 트리거(enrollments_no_schedule_conflict) 제거"도
-- 있었지만, integrity_check.sql TEST6의 기존 주석("트리거 코드 자체는 제거하지 않고 유지 —
-- 강사가 여러 명으로 늘면 그 즉시 유효해지는 저비용 안전장치이기 때문")을 이번에 다시 읽고
-- **이 마이그레이션에서는 손대지 않기로 했다** — 계획을 세울 때는 몰랐던, 이미 내려진 설계
-- 판단과 부딪힌다. 사용자 확인 후 별도로 처리한다(설계 검토 참고).

-- 1. 반려 사유 제거(G7: "반려 사유는 없어도 된다").
drop table public.enrollment_admin_notes;

-- create or replace는 매개변수 목록이 같을 때만 "교체"고, 다르면 오버로드로 새로 생긴다.
-- p_set_note/p_note(기본값 있는 매개변수)를 없애 시그니처 자체가 바뀌므로, 예전 6개짜리
-- 정의를 먼저 명시적으로 지운다 — 안 그러면 4개 인자 호출이 두 함수 모두와 매칭돼
-- "함수가 모호합니다" 에러가 난다.
drop function public.transition_enrollment(uuid, uuid, text, text, boolean, text);

create function public.transition_enrollment(
  p_enrollment_id uuid,
  p_actor_id uuid,
  p_event_type text,
  p_next_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enrollment record;
  v_email_verified boolean;
  v_actor_role text;
  v_allowed_from text[];
begin
  v_allowed_from := case p_next_status
    when 'ENROLLED'  then array['PENDING']
    when 'REJECTED'  then array['PENDING']
    when 'CANCELLED' then array['PENDING', 'ENROLLED']
    else null
  end;

  if v_allowed_from is null then
    raise exception '허용되지 않은 전이 대상 상태입니다: %', p_next_status;
  end if;

  select id, user_id, course_offering_id, enrollment_status, payment_status
    into v_enrollment
  from public.enrollments
  where id = p_enrollment_id
  for update;

  if v_enrollment.id is null then
    raise exception '신청 내역을 찾을 수 없습니다.';
  end if;

  if not (v_enrollment.enrollment_status = any (v_allowed_from)) then
    raise exception '이미 처리된 신청입니다(현재 상태: %). 화면을 새로고침한 뒤 다시 확인해 주세요.',
      v_enrollment.enrollment_status
      using errcode = 'restrict_violation';
  end if;

  if p_next_status = 'ENROLLED' then
    select email_verified into v_email_verified
    from public.users where id = v_enrollment.user_id;

    if coalesce(v_email_verified, false) is not true then
      raise exception '이 학생은 디스코드에서 이메일 인증을 해야 합니다. 인증 후 다시 로그인하면 승인할 수 있습니다.';
    end if;
  end if;

  if p_next_status = 'CANCELLED' and v_enrollment.payment_status <> 'UNPAID' then
    raise exception '이미 결제된 건은 취소가 아니라 환불로 처리해야 합니다.';
  end if;

  update public.enrollments
  set enrollment_status = p_next_status,
      enrolled_at = case when p_next_status = 'ENROLLED' then now() else enrolled_at end,
      enrollment_cancelled_at = case when p_next_status = 'CANCELLED' then now() else enrollment_cancelled_at end
  where id = p_enrollment_id
    and enrollment_status = any (v_allowed_from);

  if not found then
    raise exception '이미 처리된 신청입니다. 화면을 새로고침한 뒤 다시 확인해 주세요.'
      using errcode = 'restrict_violation';
  end if;

  select role into v_actor_role from public.users where id = p_actor_id;

  insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, actor_user_id, enrollment_id)
  values (
    v_enrollment.user_id,
    v_enrollment.course_offering_id,
    p_event_type,
    case when v_actor_role = 'ADMIN' then 'ADMIN' else 'MANAGER' end,
    p_actor_id,
    p_enrollment_id
  );

  if p_next_status in ('REJECTED', 'CANCELLED') then
    perform public.release_course_offering_seat(v_enrollment.course_offering_id);
  end if;
end;
$$;

-- 2. 안 쓰는 컬럼 3개 제거 — 실제 앱·DB 함수 어디서도 참조하지 않음(2026-09-23 조사 부록
--    N4). 값이 있는 행이 있으면(예상 밖 사용 흔적) 중단한다.
do $$
declare
  v_nonempty integer;
begin
  select count(*) into v_nonempty
  from public.enrollments
  where payment_link is not null or payment_note is not null or enrollment_note is not null;

  if v_nonempty > 0 then
    raise exception 'payment_link/payment_note/enrollment_note에 값이 있는 행이 %건 있습니다 — 마이그레이션을 중단합니다.', v_nonempty;
  end if;
end $$;

alter table public.enrollments
  drop column payment_link,
  drop column payment_note,
  drop column enrollment_note;

-- 3. 죽은 상태값 COMPLETED 제거 — 이 값을 설정하는 코드가 없다(수료 처리
--    경로 자체가 시스템에 없음). 해당 행이 있으면 중단한다.
do $$
declare
  v_completed integer;
begin
  select count(*) into v_completed from public.enrollments where enrollment_status = 'COMPLETED';
  if v_completed > 0 then
    raise exception 'enrollment_status = COMPLETED인 행이 %건 있습니다 — 마이그레이션을 중단합니다.', v_completed;
  end if;
end $$;

alter table public.enrollments drop constraint enrollments_enrollment_status_check;
alter table public.enrollments add constraint enrollments_enrollment_status_check
  check (enrollment_status in ('PENDING', 'ENROLLED', 'REJECTED', 'CANCELLED'));

-- enrollments_status_consistency CHECK(별도 제약, enrolled_at/enrollment_cancelled_at
-- 조합을 검사)에도 COMPLETED 분기가 있지만 건드리지 않는다 — 위 enrollment_status CHECK가
-- COMPLETED 자체를 막으므로 이 분기는 이제 도달할 수 없는 죽은 코드일 뿐 해가 없다. 두
-- 제약을 한 마이그레이션에서 동시에 바꾸면 검토 범위가 커지므로, 필요해지면 별도로 정리한다.
