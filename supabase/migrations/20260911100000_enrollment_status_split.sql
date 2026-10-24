-- enrollments.status가 "수강 상태"와 "결제 상태"를 한 컬럼에 섞고 있어 (ENROLLED, REFUNDED)처럼
-- 실제로 일어나는 조합("등록은 유지되지만 결제만 환불됨")을 표현할 수 없었다. 두 축으로 분리한다.
--
--
-- 이 저장소엔 아직 운영 DB가 없고 로컬 테스트 데이터만 있으므로, 백필 규칙은
-- 다음 가정을 따른다: 기존 status='REFUNDED'는 "환불까지 갔다"는 사실만 담고 있고 수강 자체가
-- 계속됐는지는 구분하지 않았으므로, enrolled_at 유무로 최선 추정한다(등록된 적 있으면 CANCELLED,
-- 없으면 REJECTED). 실제 운영 데이터가 생긴 뒤에는 이런 손실 없는 백필이 항상 가능하도록
-- 이번 재설계로 구조를 바꾸는 것이다.

alter table public.enrollments
  add column enrollment_status text,
  add column payment_status text;

update public.enrollments
set
  enrollment_status = case
    when status = 'REFUNDED' and enrolled_at is not null then 'CANCELLED'
    when status = 'REFUNDED' then 'REJECTED'
    else status
  end,
  payment_status = case
    when status = 'REFUNDED' then 'REFUNDED'
    when paid_at is not null then 'PAID'
    else 'UNPAID'
  end;

alter table public.enrollments
  alter column enrollment_status set not null,
  alter column enrollment_status set default 'PENDING',
  alter column payment_status set not null,
  alter column payment_status set default 'UNPAID';

alter table public.enrollments
  add constraint enrollments_enrollment_status_check
    check (enrollment_status in ('PENDING', 'ENROLLED', 'COMPLETED', 'REJECTED', 'CANCELLED')),
  add constraint enrollments_payment_status_check
    check (payment_status in ('UNPAID', 'PAID', 'REFUNDED'));

-- 기존 CHECK 2개를 새 두 컬럼 기준으로 재작성한다(같은 취지: 상태와 시각이 항상 맞아떨어지게 강제).
alter table public.enrollments drop constraint enrollments_status_consistency;
alter table public.enrollments
  add constraint enrollments_status_consistency check (
    case enrollment_status
      when 'PENDING'   then enrolled_at is null and enrollment_cancelled_at is null
      when 'ENROLLED'  then enrolled_at is not null and enrollment_cancelled_at is null
      when 'COMPLETED' then enrolled_at is not null and enrollment_cancelled_at is null
      when 'REJECTED'  then enrolled_at is null
      when 'CANCELLED' then enrollment_cancelled_at is not null
      else false
    end
  );

alter table public.enrollments drop constraint enrollments_payment_consistency;
alter table public.enrollments
  add constraint enrollments_payment_consistency check (
    case payment_status
      when 'UNPAID'   then paid_at is null and payment_method is null and payment_cancelled_at is null
      when 'PAID'     then paid_at is not null and payment_method is not null and payment_cancelled_at is null
      when 'REFUNDED' then paid_at is not null and payment_method is not null
                           and payment_cancelled_at is not null and payment_cancelled_at >= paid_at
      else false
    end
  );

-- 학생 개인 스케줄 겹침 트리거가 옛 status 컬럼을 "update of" 절에서 직접 참조하고 있어(의존성),
-- status 컬럼을 드롭하기 전에 먼저 트리거를 내려야 한다(안 그러면 "다른 객체가 의존 중" 에러).
-- (supabase/migrations/20260910180300_discount_rules_and_enrollment_expansion.sql:100-131)
drop trigger enrollments_no_schedule_conflict on public.enrollments;

alter table public.enrollments drop constraint enrollments_status_check;
alter table public.enrollments drop column status;

create or replace function public.check_no_student_schedule_conflict()
returns trigger
language plpgsql
as $$
begin
  if new.enrollment_status not in ('PENDING', 'ENROLLED') then
    return new;
  end if;

  if exists (
    select 1
    from public.enrollments e
    join public.course_sessions cs_old on cs_old.course_offering_id = e.course_offering_id
    join public.course_sessions cs_new on cs_new.course_offering_id = new.course_offering_id
    where e.user_id = new.user_id
      and e.id <> new.id
      and e.enrollment_status in ('PENDING', 'ENROLLED')
      and cs_old.day_of_week = cs_new.day_of_week
      and public.timerange(cs_old.start_time, cs_old.end_time) && public.timerange(cs_new.start_time, cs_new.end_time)
      and daterange(cs_old.valid_from, cs_old.valid_until, '[]') && daterange(cs_new.valid_from, cs_new.valid_until, '[]')
  ) then
    raise exception '겹치는 시간대에 신청/등록된 다른 강의가 있어 신청할 수 없습니다.';
  end if;

  return new;
end;
$$;

create trigger enrollments_no_schedule_conflict
  before insert or update of course_offering_id, enrollment_status on public.enrollments
  for each row execute function public.check_no_student_schedule_conflict();

create index on public.enrollments (enrollment_status);
create index on public.enrollments (payment_status);
