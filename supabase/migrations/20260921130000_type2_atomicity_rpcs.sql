-- 원자성 위험 유형 2 해결(2026-09-21 로 재조사·설계).
--
-- 지금까지 3개 관리자 커맨드가 여러 번의 순차적 비-트랜잭션 supabase-js 호출로 짜여 있어,
-- 중간에 프로세스가 죽으면 업무 데이터 자체가 불일치 상태로 남을 수 있었다. Postgres
-- 함수(RPC) 안으로 옮겨 하나의 트랜잭션으로 묶는다 — 이 저장소가 이미 complete_signup()/
-- apply_for_offering()/record_payment_event()에서 쓰는 것과 같은 해법이다. 함수 안에서
-- raise exception이 나면 그 함수가 이미 실행한 것까지 Postgres가 전부 자동으로 롤백하므로,
-- 수동 보상 코드(예: 실패 시 방금 만든 행을 직접 DELETE하는 것)가 필요 없어진다.

-- =========================================================
-- 1. create_course_offering() — 개설강의 INSERT + 회차 INSERT를 한 트랜잭션으로
-- =========================================================
-- SECURITY INVOKER(기본값, 명시 안 함) — 호출자의 세션 권한으로 실행된다. course_offerings/
-- course_sessions 둘 다 "관리자만 등록/수정/삭제 가능"(is_admin()) RLS가 이미 있고, 지금도
-- app/admin/course-offerings/actions.ts가 세션 클라이언트(createClient())로 호출하므로
-- 보안 모델이 그대로 유지된다 — REVOKE/GRANT를 새로 걸 필요가 없다(8개 민감 RPC와 다른 점).
create or replace function public.create_course_offering(
  p_course_id uuid,
  p_label text,
  p_capacity integer,
  p_price integer,
  p_location text,
  p_is_one_time boolean,
  p_opens_at timestamptz,
  p_ends_at timestamptz,
  p_required_terms_types text[],
  p_grants jsonb,
  p_session_start_time time,
  p_session_end_time time,
  p_days_of_week smallint[]
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_offering_id uuid;
  v_valid_from date;
  v_valid_until date;
  v_days smallint[];
begin
  insert into public.course_offerings (
    course_id, label, capacity, remaining_seats, price, location, is_one_time,
    opens_at, ends_at, required_terms_types, grants
  ) values (
    p_course_id, p_label, p_capacity, p_capacity, p_price, p_location, p_is_one_time,
    p_opens_at, p_ends_at, p_required_terms_types, p_grants
  )
  returning id into v_offering_id;

  if p_session_start_time is not null and p_session_end_time is not null then
    v_valid_from := p_opens_at::date;
    v_valid_until := coalesce(p_ends_at::date, p_opens_at::date);
    -- 1회성 강의는 요일 체크박스를 안 골라도 개설일시의 실제 요일로 자동 지정한다(기존
    -- TS 로직 그대로).
    v_days := case
      when p_is_one_time then array[extract(dow from p_opens_at)::smallint]
      else p_days_of_week
    end;

    if v_days is not null and array_length(v_days, 1) > 0 then
      -- 겹치는 시간대는 course_sessions의 EXCLUDE 제약이 exclusion_violation으로 거부한다.
      -- 그 예외가 이 함수 밖으로 그대로 전파되면서, 방금 insert한 course_offerings 행도
      -- Postgres가 자동으로 롤백한다 — 수동 보상 DELETE가 필요 없다(2026-09-21 이전에는
      -- TS 레이어에서 실패 시 course_offerings를 수동으로 delete했다).
      insert into public.course_sessions (
        course_offering_id, day_of_week, start_time, end_time, valid_from, valid_until
      )
      select v_offering_id, d, p_session_start_time, p_session_end_time, v_valid_from, v_valid_until
      from unnest(v_days) as d;
    end if;
  end if;

  return v_offering_id;
end;
$$;

-- =========================================================
-- 2. delete_course_offering() — 신청건수 체크 + 회차 DELETE + deleted_at UPDATE를 한 트랜잭션으로
-- =========================================================
-- 위와 동일하게 SECURITY INVOKER — RLS(is_admin())가 그대로 보호한다.
create or replace function public.delete_course_offering(p_offering_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_enrollment_count integer;
begin
  select count(*) into v_enrollment_count
  from public.enrollments
  where course_offering_id = p_offering_id;

  if v_enrollment_count > 0 then
    raise exception '삭제 실패(신청 내역이 있으면 삭제할 수 없습니다).';
  end if;

  -- course_sessions는 순수 일정 메타데이터라 역사적 가치가 없다 — 실제로 지워서 그 시간대를
  -- 다른 개설강의가 다시 쓸 수 있게 한다(기존 TS 로직과 동일한 이유).
  delete from public.course_sessions where course_offering_id = p_offering_id;

  update public.course_offerings
  set deleted_at = now()
  where id = p_offering_id;
end;
$$;

-- =========================================================
-- 3. transition_enrollment() — 승인/반려/취소를 한 트랜잭션으로
-- =========================================================
-- SECURITY DEFINER — enrollments/enrollment_events는 INSERT/UPDATE RLS 정책 자체가 없어
-- (조회 정책만 있음), 지금도 app/admin/enrollments/actions.ts가 createAdminClient()
-- (service_role)로 RLS를 우회해 쓰고 있다. 그 신뢰 경계를 그대로 옮긴다 — 8개 민감 RPC와
-- 같은 계보이므로 REVOKE/GRANT도 동일하게 적용한다(아래 참고). 권한 검증(APPROVE_ENROLLMENTS
-- 보유 여부) 자체는 이 함수가 하지 않는다 — 지금도 TS의 runStaffCommand()가 호출 전에
-- requirePermission()으로 이미 검증하고, service_role 실행 권한 자체가 REVOKE돼 있어
-- 이 함수에 도달할 수 있는 경로가 그 검증을 통과한 서버 코드뿐이기 때문이다(다른 8개
-- 민감 RPC와 동일한 신뢰 모델).
create or replace function public.transition_enrollment(
  p_enrollment_id uuid,
  p_actor_id uuid,
  p_event_type text,
  p_next_status text,
  p_set_note boolean default false,
  p_note text default null
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
begin
  select id, user_id, course_offering_id, payment_status
    into v_enrollment
  from public.enrollments
  where id = p_enrollment_id;

  if v_enrollment.id is null then
    raise exception '신청 내역을 찾을 수 없습니다.';
  end if;

  -- 그 학생 동결. 관리자·매니저 본인 email_verified는 보지 않는다.
  select email_verified into v_email_verified
  from public.users where id = v_enrollment.user_id;

  if coalesce(v_email_verified, false) is not true then
    raise exception '이 학생은 디스코드에서 이메일 인증을 해야 합니다. 인증 후 다시 로그인한 뒤에 승인·반려·취소할 수 있습니다.';
  end if;

  if p_next_status = 'CANCELLED' and v_enrollment.payment_status <> 'UNPAID' then
    raise exception '이미 결제된 건은 취소가 아니라 환불로 처리해야 합니다.';
  end if;

  select role into v_actor_role from public.users where id = p_actor_id;

  insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, actor_user_id)
  values (
    v_enrollment.user_id,
    v_enrollment.course_offering_id,
    p_event_type,
    case when v_actor_role = 'ADMIN' then 'ADMIN' else 'MANAGER' end,
    p_actor_id
  );

  -- enrollments_status_consistency CHECK가 ENROLLED 상태엔 enrolled_at을 요구한다
  -- (20260911100000_enrollment_status_split.sql). 반려 사유는 저장만 하고 화면에 노출하지
  -- 않는다(2026-09-11 확정) — p_set_note가 false면(승인/취소) 기존 값을 건드리지 않는다.
  update public.enrollments
  set enrollment_status = p_next_status,
      enrolled_at = case when p_next_status = 'ENROLLED' then now() else enrolled_at end,
      enrollment_cancelled_at = case when p_next_status = 'CANCELLED' then now() else enrollment_cancelled_at end,
      enrollment_note = case when p_set_note then nullif(p_note, '') else enrollment_note end
  where id = p_enrollment_id;

  if p_next_status in ('REJECTED', 'CANCELLED') then
    -- 반려/취소는 신청 시 차감했던 좌석을 되돌려준다. 이 함수도 SECURITY DEFINER라
    -- current_user가 postgres(소유자)로 바뀌어 REVOKE 여부와 무관하게 내부 호출된다
    -- (apply_for_offering()이 reserve_course_offering_seat()을 부르는 것과 동일한 원리).
    perform public.release_course_offering_seat(v_enrollment.course_offering_id);
  end if;
end;
$$;

-- =========================================================
-- 4. transition_enrollment()만 실행 권한을 좁힌다(8개 민감 RPC와 동일 원칙)
-- =========================================================
-- create_course_offering()/delete_course_offering()은 SECURITY INVOKER라 REVOKE하지
-- 않는다 — RLS(is_admin())가 이미 보호하므로, 실행 권한 자체를 좁히면 오히려 정상적인
-- 관리자 호출까지 막힐 위험이 있다.
revoke execute on function public.transition_enrollment(uuid, uuid, text, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.transition_enrollment(uuid, uuid, text, text, boolean, text)
  to service_role;
