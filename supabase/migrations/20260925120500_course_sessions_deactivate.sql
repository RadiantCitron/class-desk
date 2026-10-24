--
-- 개설강의를 지울 때 회차 행을 DELETE하던 이유는 "같은 시간대를 다른 개설강의가 다시 쓰게"
-- (EXCLUDE 겹침 검사에서 빼기)였다. 행은 남기고 비활성 표시만 하고, 겹침 검사는 살아 있는 회차끼리만
-- 하도록 EXCLUDE에 WHERE를 붙인다(부분 배제 제약).

alter table public.course_sessions
  add column deactivated_at timestamptz,
  add column deactivated_reason text;
alter table public.course_sessions add constraint course_sessions_deactivated_reason_pair
  check ((deactivated_at is null) = (deactivated_reason is null));

-- 기존 EXCLUDE 제약은 이름 없이 만들어졌다(20260910180200) — 카탈로그에서 찾아 지운다.
-- 정확히 1개여야 한다(아니면 중단).
do $$
declare
  v_count integer;
  v_name text;
begin
  select count(*), min(conname) into v_count, v_name
  from pg_constraint
  where conrelid = 'public.course_sessions'::regclass and contype = 'x';

  if v_count <> 1 then
    raise exception 'course_sessions의 EXCLUDE 제약이 1개가 아닙니다(%개) — 마이그레이션을 중단합니다.', v_count;
  end if;

  execute format('alter table public.course_sessions drop constraint %I', v_name);
end $$;

alter table public.course_sessions add constraint course_sessions_no_overlap_active
  exclude using gist (
    day_of_week with =,
    public.timerange(start_time, end_time) with &&,
    daterange(valid_from, valid_until, '[]') with &&
  ) where (deactivated_at is null);

-- 숨은 삭제 경로 2개를 막는다: FK 규칙 자체가 "부모가
-- 지워지면 자식도 지운다/비운다"는 삭제 규칙이다. restrict로 바꾼다. FK 이름은 카탈로그에서 찾는다.
do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  where c.conrelid = 'public.course_sessions'::regclass and c.contype = 'f' and a.attname = 'course_offering_id';
  if v_name is null then
    raise exception 'course_sessions.course_offering_id FK를 찾지 못했습니다 — 마이그레이션을 중단합니다.';
  end if;
  execute format('alter table public.course_sessions drop constraint %I', v_name);

  select c.conname into v_name
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  where c.conrelid = 'public.orders'::regclass and c.contype = 'f' and a.attname = 'discount_rule_id';
  if v_name is null then
    raise exception 'orders.discount_rule_id FK를 찾지 못했습니다 — 마이그레이션을 중단합니다.';
  end if;
  execute format('alter table public.orders drop constraint %I', v_name);
end $$;

alter table public.course_sessions
  add constraint course_sessions_course_offering_id_fkey
  foreign key (course_offering_id) references public.course_offerings (id) on delete restrict;
alter table public.orders
  add constraint orders_discount_rule_id_fkey
  foreign key (discount_rule_id) references public.discount_rules (id) on delete restrict;

-- delete_course_offering — 사유·행위자를 받는다(매개변수가 늘어나므로 drop 후 create). 회차는
-- 지우지 않고 비활성 표시만. SECURITY INVOKER 그대로(관리자 RLS가 최종 방어선, 20260921130000 주석).
drop function public.delete_course_offering(uuid);

create function public.delete_course_offering(p_offering_id uuid, p_reason text, p_actor uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_order_count integer;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '삭제 사유를 입력해야 합니다.';
  end if;

  select count(*) into v_order_count
  from public.orders
  where course_offering_id = p_offering_id;

  if v_order_count > 0 then
    raise exception '삭제 실패(신청 내역이 있으면 삭제할 수 없습니다).';
  end if;

  update public.course_sessions
  set deactivated_at = now(),
      deactivated_reason = p_reason
  where course_offering_id = p_offering_id
    and deactivated_at is null;

  update public.course_offerings
  set deleted_at = now(),
      deleted_reason = p_reason,
      deleted_by = p_actor
  where id = p_offering_id;
end;
$$;
