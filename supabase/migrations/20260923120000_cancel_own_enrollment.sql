-- 서비스 오픈 전 크리티컬 수정 3단계(2026-09-23): 학생 본인 취소를 원자적 RPC로.
-- 진단 전문은 .
--
--   ④ 2026-09-21에 관리자 커맨드 3개는 transition_enrollment로 묶였는데 학생 취소만
--      빠져 있었다. 앱에서 ①enrollment_events INSERT ②enrollments UPDATE
--      ③release_course_offering_seat RPC를 순차로 3번 호출하는 구조라:
--        - ②와 ③ 사이에서 프로세스가 죽으면 신청은 취소됐는데 좌석은 영구히 잠긴다
--          (7일 방치 PENDING 점검으로도 안 잡힌다 — 상태가 CANCELLED라서).
--        - 상태를 읽고 UPDATE하는 사이가 열려 있어(TOCTOU), 학생이 "신청 취소"를
--          더블클릭하면 두 요청이 각자 PENDING을 읽고 각자 좌석을 반환해 좌석이 +2 된다.
--   ③ 취소는 "권한을 빼는" 조작이므로 이메일 미인증자도 할 수 있어야 한다. 앱 쪽에서
--      requireWritableProfile()(이메일 인증 요구)을 requireProfile()로 낮추는 변경과
--      짝을 이룬다 — 관리자 쪽 전이(transition_enrollment)에서 이미 같은 정정을 했다.
--
-- 소유권 검사를 함수 안에서 하는 형태는 consume_entitlement(p_entitlement_id, p_user_id)
-- 선례를 그대로 따른다(20260915020000_consume_entitlement.sql).

create or replace function public.cancel_own_enrollment(
  p_enrollment_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enrollment record;
begin
  -- for update로 잠가 더블클릭(두 요청이 같은 행을 동시에 취소)을 직렬화한다.
  select id, user_id, course_offering_id, enrollment_status, payment_status
    into v_enrollment
  from public.enrollments
  where id = p_enrollment_id
  for update;

  if v_enrollment.id is null then
    raise exception '신청 내역을 찾을 수 없습니다.';
  end if;

  if v_enrollment.user_id <> p_user_id then
    raise exception '본인의 신청 건만 취소할 수 있습니다.';
  end if;

  -- 결제 전(UNPAID)에만 허용한다 — 이미 결제된 건은 환불이 얽혀 있어 관리자가 처리한다
  -- (반자동 운영 원칙).
  if v_enrollment.payment_status <> 'UNPAID' then
    raise exception '이미 결제된 건은 여기서 취소할 수 없습니다. 환불은 관리자에게 문의해 주세요.';
  end if;

  update public.enrollments
  set enrollment_status = 'CANCELLED',
      enrollment_cancelled_at = now()
  where id = p_enrollment_id
    and enrollment_status in ('PENDING', 'ENROLLED');

  if not found then
    raise exception '이미 종료되었거나 취소된 신청 건입니다.'
      using errcode = 'restrict_violation';
  end if;

  -- 이벤트와 좌석 반환 모두 전이가 성공한 뒤에만 실행되고, 셋 다 이 함수 = 한 트랜잭션
  -- 안에 있으므로 중간 실패 시 통째로 롤백된다.
  insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, actor_user_id)
  values (v_enrollment.user_id, v_enrollment.course_offering_id, 'CANCELLED', 'STUDENT', p_user_id);

  perform public.release_course_offering_seat(v_enrollment.course_offering_id);
end;
$$;

-- 8개 민감 RPC와 동일 원칙 — 클라이언트가 PostgREST로 직접 호출해 남의 신청을 취소하지
-- 못하게 실행 권한을 service_role로 좁힌다(소유권 검사가 함수 안에 있긴 하지만,
-- p_user_id를 호출자가 지정하므로 실행 권한 자체를 막는 것이 최종 방어선이다).
revoke execute on function public.cancel_own_enrollment(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_own_enrollment(uuid, uuid)
  to service_role;
