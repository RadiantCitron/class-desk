-- 서비스 오픈 전 크리티컬 수정 1단계(2026-09-23): 신청 상태 전이 검증 + 반려 사유 분리.
-- 진단 전문은 .
--
-- 고치는 것 3가지(전부 transition_enrollment 한 함수와 그 주변):
--   ① 전이 검사 부재 — 현재 상태를 읽지도 않고 `where id = ?`로만 UPDATE해서, 반려 버튼을
--      낡은 탭에서 한 번 더 누르면 좌석이 또 반환되고(정원 뻥튀기), REJECTED 건을 승인하면
--      좌석 차감 없이 부활했다.
--   ③ email_verified 가드가 승인·반려·취소 전부를 막아, 신청 후 이메일 인증을 푼 학생의
--      좌석은 아무도(관리자도 본인도) 회수할 수 없었다 — 승인에만 적용하도록 좁힌다.
--   ⑤ 반려 사유(enrollment_note)가 enrollments 행에 있어서, RLS가 행 단위인 탓에 학생 본인이
--      PostgREST로 직접 조회하면 내부 메모를 읽을 수 있었다 — 관리자 전용 테이블로 분리한다.

-- =========================================================
-- 1. 반려 사유 분리 (⑤)
-- =========================================================
-- enrollments에 두는 한 학생에게서 숨길 방법이 없다(RLS는 행 단위이지 컬럼 단위가 아니다).
-- 컬럼 REVOKE는 select * 를 깨뜨려 부작용이 크므로 별도 테이블로 옮긴다.
create table public.enrollment_admin_notes (
  enrollment_id uuid primary key references public.enrollments (id) on delete restrict,
  note text not null,
  written_by uuid references public.users (id),
  updated_at timestamptz not null default now()
);

alter table public.enrollment_admin_notes enable row level security;

-- manager_permissions와 같은 원칙: SELECT 정책만 두고 쓰기 정책은 두지 않는다
-- (쓰기는 아래 transition_enrollment()가 service_role/SECURITY DEFINER로만 수행).
-- 매니저에게도 열지 않는다 — 반려 사유는 ADMIN 내부 메모다.
create policy "관리자만 반려 사유 조회 가능"
  on public.enrollment_admin_notes for select
  using (is_admin());

-- 기존 값 이전 후 원본을 비운다. 컬럼 자체는 드롭하지 않는다 — 드롭은 비가역이고,
-- 값만 비워도 유출 경로는 닫히며 롤백이 쉬워진다.
insert into public.enrollment_admin_notes (enrollment_id, note)
select id, enrollment_note
from public.enrollments
where enrollment_note is not null;

update public.enrollments set enrollment_note = null where enrollment_note is not null;

comment on column public.enrollments.enrollment_note is
  '2026-09-23부터 사용하지 않는다. 반려 사유는 public.enrollment_admin_notes에 있다(학생에게 노출되지 않도록 분리).';

-- =========================================================
-- 2. transition_enrollment 재작성 (①③⑤)
-- =========================================================
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
  v_allowed_from text[];
begin
  -- 허용 전이표. 이 함수가 만들 수 있는 상태는 셋뿐이고, 각각 출발 가능한 상태가 정해져 있다.
  -- (COMPLETED는 이 시스템에 아직 수료 처리 경로가 없어 여기서 다루지 않는다.)
  v_allowed_from := case p_next_status
    when 'ENROLLED'  then array['PENDING']
    when 'REJECTED'  then array['PENDING']
    when 'CANCELLED' then array['PENDING', 'ENROLLED']
    else null
  end;

  if v_allowed_from is null then
    raise exception '허용되지 않은 전이 대상 상태입니다: %', p_next_status;
  end if;

  -- for update로 행을 잠가 동시 클릭(두 매니저가 같은 건을 동시에 반려)을 직렬화한다.
  -- 아래 UPDATE의 조건절은 그 위의 이중 방어다.
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

  -- 이메일 인증은 "권한을 주는" 승인에만 요구한다(2026-09-23 정정). 반려·취소는 권한을
  -- 빼는 조작이라 막으면 안 된다 — 예전엔 셋 다 막아서, 신청 후 디스코드 이메일 인증을
  -- 푼 학생의 좌석을 아무도 회수할 수 없었다(관리자도 학생 본인도).
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

  -- enrollments_status_consistency CHECK가 ENROLLED엔 enrolled_at을, CANCELLED엔
  -- enrollment_cancelled_at을 요구한다(20260911100000_enrollment_status_split.sql).
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

  -- 반려 사유는 관리자 전용 테이블에 쓴다(학생에게 노출되지 않는다).
  if p_set_note then
    if nullif(p_note, '') is null then
      delete from public.enrollment_admin_notes where enrollment_id = p_enrollment_id;
    else
      insert into public.enrollment_admin_notes (enrollment_id, note, written_by)
      values (p_enrollment_id, p_note, p_actor_id)
      on conflict (enrollment_id) do update
        set note = excluded.note,
            written_by = excluded.written_by,
            updated_at = now();
    end if;
  end if;

  select role into v_actor_role from public.users where id = p_actor_id;

  -- 이벤트는 전이가 실제로 성공한 뒤에만 남긴다(예전엔 UPDATE보다 먼저 INSERT했다).
  insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, actor_user_id)
  values (
    v_enrollment.user_id,
    v_enrollment.course_offering_id,
    p_event_type,
    case when v_actor_role = 'ADMIN' then 'ADMIN' else 'MANAGER' end,
    p_actor_id
  );

  -- 좌석 반환도 전이가 성공한 경우에만 실행되므로 자동으로 멱등해진다 — 같은 건을 두 번
  -- 반려해도 두 번째는 위에서 이미 예외로 끊긴다.
  if p_next_status in ('REJECTED', 'CANCELLED') then
    perform public.release_course_offering_seat(v_enrollment.course_offering_id);
  end if;
end;
$$;
