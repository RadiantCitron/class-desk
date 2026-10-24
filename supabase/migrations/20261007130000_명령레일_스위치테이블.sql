-- 명령 레일(ADR-0015) — 통제 스위치 테이블 하나.
--
-- 시스템 봉쇄(system_gates의 PAYMENT/SIGNUP/LOGIN)와 학생 3축 제한(student_restrictions)을
-- "층(SYSTEM/MODULE/COMMAND) × 대상 × 유저(null = 전원)" 한 테이블로 합친다. 행 하나가 차단 하나다.
--   시스템 봉쇄            SYSTEM  null                     null
--   결제 모듈 차단          MODULE  PAYMENT                  null
--   환불 요청만 차단        COMMAND PAYMENT_REFUND_REQUEST   null
--   한 유저의 결제만 차단   MODULE  PAYMENT                  그 유저
--   한 유저 완전 차단       SYSTEM  null                     그 유저
-- 모듈·명령 이름 목록의 주인은 TS 등록부(lib/commands/registry.ts)다 — DB는 값만 갖는다(system_gates와 같은 계보).
--
-- 삭제는 없다. 해제는 해제 시각·사유·행위자를 적는 UPDATE 한 번뿐이고, 해제된 행은 이력으로 남는다.
-- 감사 on/off(system_gates의 AUDIT 행)는 0층 스위치라 옮기지 않는다(lib/audit/switch.ts가 그대로 읽는다).

create table public.rail_switches (
  id uuid primary key default gen_random_uuid(),
  level text not null check (level in ('SYSTEM', 'MODULE', 'COMMAND')),
  target text,
  user_id uuid references public.users (id) on delete restrict,
  reason text not null check (length(btrim(reason)) > 0),
  set_by uuid not null references public.users (id) on delete restrict,
  set_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_by uuid references public.users (id) on delete restrict,
  cleared_reason text,
  -- CHECK는 결과가 NULL이면 통과시킨다 — 그래서 각 갈래에 "is not null"을 명시해 NULL이 끼어들 틈을 없앤다.
  constraint rail_switches_target_by_level check (
    (level = 'SYSTEM' and target is null)
    or (level = 'MODULE' and target is not null and target in ('MEMBER', 'ORDER', 'PAYMENT', 'ENTITLEMENT', 'CS'))
    or (level = 'COMMAND' and target is not null and length(btrim(target)) > 0)
  ),
  -- 공리(통제실 통로, v4 1항) — 이 명령들을 대상으로 하는 스위치는 만들 수 없다. 끄면 아무도 되돌릴 수 없다.
  -- 목록은 lib/commands/registry.ts의 axiom: true와 같아야 한다(lib/commands/switches.guard.test.ts가 대조).
  constraint rail_switches_axiom_untouchable check (
    not (level = 'COMMAND' and target in (
      'LOGIN', 'LOGIN_VIEW', 'LOGOUT', 'RAIL_SWITCH_VIEW', 'RAIL_SWITCH_SET', 'ADMIN_SHELL_VIEW'
    ))
  ),
  constraint rail_switches_cleared_triple check (
    (cleared_at is null and cleared_by is null and cleared_reason is null)
    or (cleared_at is not null and cleared_by is not null and cleared_reason is not null and length(btrim(cleared_reason)) > 0)
  )
);

comment on table public.rail_switches is
  '명령 레일 통제 스위치. 활성 행 = cleared_at is null. 층 SYSTEM/MODULE/COMMAND × target × user_id(null=전원). 삭제 없음.';

-- 같은 대상의 유효한 스위치는 하나(전원 대상은 user_id null을 하나의 값으로 본다).
create unique index rail_switches_active_uk
  on public.rail_switches (level, coalesce(target, ''), coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where cleared_at is null;

-- 판정 조회용(활성 행만, 전원 + 본인).
create index rail_switches_active_user_idx on public.rail_switches (user_id) where cleared_at is null;

-- 행은 지우지 않고, 바꿀 수 있는 것은 "활성 행을 해제하는 것" 하나뿐이다(이력 보존).
create or replace function public.rail_switches_guard_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '통제 스위치 행은 삭제할 수 없습니다. 해제(cleared_at)로 기록하세요.'
      using errcode = 'restrict_violation';
  end if;
  if old.cleared_at is not null then
    raise exception '이미 해제된 통제 스위치는 바꿀 수 없습니다.' using errcode = 'restrict_violation';
  end if;
  if new.id is distinct from old.id
     or new.level is distinct from old.level
     or new.target is distinct from old.target
     or new.user_id is distinct from old.user_id
     or new.reason is distinct from old.reason
     or new.set_by is distinct from old.set_by
     or new.set_at is distinct from old.set_at then
    raise exception '통제 스위치는 해제만 할 수 있습니다(대상·사유 변경 불가 — 해제 후 새로 거세요).'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger rail_switches_guard_update
  before update on public.rail_switches
  for each row execute function public.rail_switches_guard_mutation();

create trigger rail_switches_guard_delete
  before delete on public.rail_switches
  for each row execute function public.rail_switches_guard_mutation();

alter table public.rail_switches enable row level security;

-- 쓰기 정책은 두지 않는다 → 쓰기는 service_role만(system_gates·student_restrictions와 같다).
-- 조회: 전원 대상 행은 누구나(비로그인 포함 — 가입 화면도 봉쇄를 알아야 한다, 20260926140000 선례),
-- 본인 대상 행은 본인만, 관리자는 전부.
create policy "전원 대상 스위치는 누구나 조회"
  on public.rail_switches for select
  to anon, authenticated
  using (user_id is null);

create policy "본인 대상 스위치는 본인이 조회"
  on public.rail_switches for select
  to authenticated
  using (user_id = (select public.current_profile_id()));

create policy "관리자는 전체 조회"
  on public.rail_switches for select
  to authenticated
  using (public.is_admin());

-- 기존 값 이관 — 지금 걸려 있는 차단만 옮긴다(해제 이력은 옛 테이블에 그대로 남는다).
-- 옛 게이트 → 새 층: PAYMENT → MODULE PAYMENT, SIGNUP → COMMAND ACCOUNT_SIGNUP,
-- LOGIN → SYSTEM(전원). LOGIN은 v4에서 공리(통제실 통로)가 되어 스위치 대상이 아니므로,
-- "로그인 봉쇄"의 뜻(관리자 외 전원 이용 중지)을 SYSTEM 전원 차단으로 옮긴다.
insert into public.rail_switches (level, target, user_id, reason, set_by, set_at)
select
  case g.code when 'PAYMENT' then 'MODULE' when 'SIGNUP' then 'COMMAND' else 'SYSTEM' end,
  case g.code when 'PAYMENT' then 'PAYMENT' when 'SIGNUP' then 'ACCOUNT_SIGNUP' else null end,
  null,
  g.reason,
  g.changed_by,
  g.changed_at
from public.system_gates g
where g.status = 'CLOSED' and g.code in ('PAYMENT', 'SIGNUP', 'LOGIN');

-- 학생 제한 → 그 유저 대상 스위치: APPLY → COMMAND ORDER_APPLY, PAYMENT → MODULE PAYMENT,
-- VIEW → 지금 VIEW가 막는 두 화면(ui/views/student/home.ts·entitlements.ts) 각각 COMMAND.
insert into public.rail_switches (level, target, user_id, reason, set_by, set_at)
select m.level, m.target, r.user_id, r.reason, r.restricted_by, r.restricted_at
from public.student_restrictions r
join (values
  ('APPLY', 'COMMAND', 'ORDER_APPLY'),
  ('PAYMENT', 'MODULE', 'PAYMENT'),
  ('VIEW', 'COMMAND', 'STUDENT_HOME_VIEW'),
  ('VIEW', 'COMMAND', 'STUDENT_ENTITLEMENTS_VIEW')
) as m(scope, level, target) on m.scope = r.scope
where r.cleared_at is null;

-- 옛 테이블은 지우지 않고 쓰기를 멈춘다(삭제 없음 원칙, 이력 보존). system_gates는 AUDIT 행만 계속 쓴다.
create or replace function public.retired_control_tables_forbid_write()
returns trigger
language plpgsql
as $$
begin
  -- OLD는 UPDATE·DELETE에서만 있다 — INSERT에서 old.code를 읽지 않도록 조건을 나눈다.
  if tg_table_name = 'system_gates' and tg_op = 'UPDATE' then
    if old.code = 'AUDIT' and new.code = 'AUDIT' then
      return new;
    end if;
  end if;
  raise exception '%는 명령 레일 이관 뒤 쓰기를 멈춘 테이블입니다. rail_switches를 쓰세요.', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

create trigger system_gates_retired_update
  before update on public.system_gates
  for each row execute function public.retired_control_tables_forbid_write();

create trigger student_restrictions_retired_write
  before insert or update or delete on public.student_restrictions
  for each row execute function public.retired_control_tables_forbid_write();

-- gate_open() 재정의 — complete_signup()의 DB 최후 방어선(호출부는 complete_signup 하나, 'SIGNUP'뿐).
-- 가입은 레일에서 SYSTEM(전원) → MODULE MEMBER(전원) → COMMAND ACCOUNT_SIGNUP(전원) 중 하나라도 걸리면 막힌다 —
-- DB 방어선도 같은 세 층을 본다. 그 밖의 코드는 예전처럼 system_gates를 읽는다(AUDIT 등, 현재 DB 호출부 없음).
create or replace function public.gate_open(p_code text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select case
    when p_code = 'SIGNUP' then not exists (
      select 1 from public.rail_switches s
      where s.cleared_at is null
        and s.user_id is null
        and (
          s.level = 'SYSTEM'
          or (s.level = 'MODULE' and s.target = 'MEMBER')
          or (s.level = 'COMMAND' and s.target = 'ACCOUNT_SIGNUP')
        )
    )
    else coalesce((select g.status = 'OPEN' from public.system_gates g where g.code = p_code), true)
  end;
$$;
