-- 데이터 무결성 보강 2/2: 수강료산정기준(할인) 테이블 신설, 수강신청(enrollments)을 사용자가
-- 요구한 필드로 확장하되 "현재상태 캐시 + append-only 이력(enrollment_events/payment_events)"
-- 절충안은 유지한다. 상태-시각/결제 정합성은 CHECK로, 학생 개인 스케줄 겹침은
-- cross-table이라 트리거로 DB 차원에서 강제한다.
-- (2026-09-10 "DB 스키마 보강 설계 제안" / "재평가" 절 참고)

create table public.discount_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  discount_type text not null check (discount_type in ('PERCENT', 'FIXED')),
  discount_value integer not null check (discount_value >= 0),
  description text,
  valid_from date,
  valid_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger discount_rules_set_updated_at
  before update on public.discount_rules
  for each row execute function set_updated_at();

alter table public.discount_rules enable row level security;

create policy "로그인한 사용자는 산정기준 조회 가능"
  on public.discount_rules for select
  using (auth.role() = 'authenticated');

create policy "관리자만 산정기준 등록/수정/삭제 가능"
  on public.discount_rules for all
  using (is_admin())
  with check (is_admin());

-- =========================================================
-- enrollments(수강신청) 필드 확장
-- =========================================================
alter table public.enrollments
  add column enrolled_at timestamptz,
  add column enrollment_cancelled_at timestamptz,
  add column enrollment_note text,
  add column list_price integer,
  add column discount_rule_id uuid references public.discount_rules (id) on delete set null,
  add column final_amount integer,
  add column payment_method text,
  add column paid_at timestamptz,
  add column payment_cancelled_at timestamptz,
  add column payment_note text;

alter table public.enrollments
  add constraint enrollments_payment_method_check
    check (payment_method is null or payment_method in ('CARD', 'BANK_TRANSFER', 'OTHER'));

-- status에 COMPLETED(정상 수료) 추가 — "등록됐는데 강좌가 끝났으면 CANCELLED가 아니라 COMPLETED로
-- 관리자가 수동 전이시킨다"는 반자동 운영 원칙을 표현하기 위함.
alter table public.enrollments drop constraint enrollments_status_check;
alter table public.enrollments
  add constraint enrollments_status_check
    check (status in ('PENDING', 'ENROLLED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'REFUNDED'));

-- "등록일시는 있는데 취소일시가 없으면 수업중" 같은 사용자가 지적한 불일치를 DB가 저장 자체를
-- 거부하게 만드는 CHECK. 상태와 시각 컬럼이 항상 같이 맞아떨어지게 강제한다.
alter table public.enrollments
  add constraint enrollments_status_consistency check (
    case status
      when 'PENDING'   then enrolled_at is null and enrollment_cancelled_at is null
      when 'ENROLLED'  then enrolled_at is not null and enrollment_cancelled_at is null
      when 'COMPLETED' then enrolled_at is not null and enrollment_cancelled_at is null
      when 'REJECTED'  then enrolled_at is null
      when 'CANCELLED' then enrollment_cancelled_at is not null
      when 'REFUNDED'  then payment_cancelled_at is not null
      else false
    end
  );

-- "결제정보 없이 환불 불가", "결제정보 없이 결제 기록만 있는 상태 불가"를 DB가 강제.
alter table public.enrollments
  add constraint enrollments_payment_consistency check (
    (paid_at is null and payment_method is null and payment_cancelled_at is null)
    or (
      paid_at is not null and payment_method is not null
      and (payment_cancelled_at is null or payment_cancelled_at >= paid_at)
    )
  );

alter table public.enrollments
  add constraint enrollments_amount_sane check (
    (list_price is null or list_price >= 0)
    and (final_amount is null or (final_amount >= 0 and (list_price is null or final_amount <= list_price)))
  );

create index on public.enrollments (course_offering_id);
create index on public.enrollments (applied_at);
create index on public.enrollments (enrolled_at);
create index on public.enrollments (final_amount);

-- =========================================================
-- 학생 개인 스케줄 겹침 방지 — enrollments <-> course_sessions는 별개 테이블이라
-- 선언적 EXCLUDE로 표현할 수 없다. Postgres의 표준 해법인 트리거로 cross-table 무결성을 강제한다.
-- =========================================================
create or replace function public.check_no_student_schedule_conflict()
returns trigger
language plpgsql
as $$
begin
  if new.status not in ('PENDING', 'ENROLLED') then
    return new;
  end if;

  if exists (
    select 1
    from public.enrollments e
    join public.course_sessions cs_old on cs_old.course_offering_id = e.course_offering_id
    join public.course_sessions cs_new on cs_new.course_offering_id = new.course_offering_id
    where e.user_id = new.user_id
      and e.id <> new.id
      and e.status in ('PENDING', 'ENROLLED')
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
  before insert or update of course_offering_id, status on public.enrollments
  for each row execute function public.check_no_student_schedule_conflict();
