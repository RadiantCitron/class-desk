-- ①DLQ source 제약 복구
-- ②결제 PG 관리자 설정 테이블 신설.

-- ① 20260927120000이 dead_letters_source_check를 다시 정의하면서 20260925150500이
-- 추가한 'TOSS'를 빠뜨렸고, 'MANUAL'도 처음부터 없었다. 이 상태에서는
-- on_payment_succeeded/on_payment_refunded가 TOSS나 MANUAL 결제를 DLQ로 보내려 할 때마다
-- CHECK 위반으로 RPC 자체가 실패한다. 'PAYAPP'는 이미 있으니 그대로 둔다.
alter table public.dead_letters drop constraint dead_letters_source_check;
alter table public.dead_letters add constraint dead_letters_source_check
  check (source = any (array['PAYAPP', 'MOCK', 'STEPPAY', 'OUTBOX', 'INTEGRITY', 'AUDIT', 'INTERNAL', 'DISCORD_GUILD_JOIN', 'TOSS', 'MANUAL']));

-- ② 결제 PG 관리자 설정 — system_gates와 같은 계보(목록·검증은 코드, 상태는 DB, 사유 필수).
-- 결제 코어(lib/payment)가 아니라 PAYMENT 모듈 소유 테이블이다(module-map.ts에 등록,
-- 작업 3). 한 행짜리 싱글턴이라 PK를 고정 문자열로 둔다(system_gates의 code 패턴과 동일한
-- 발상 — "이 테이블은 항상 정확히 한 행"을 스키마로 강제한다).
create table public.payment_settings (
  id             text primary key default 'SINGLETON' check (id = 'SINGLETON'),
  active_provider text check (active_provider in ('TOSS', 'PAYAPP')),
  reason         text,
  changed_by     uuid references public.users (id),
  changed_at     timestamptz not null default now()
);

insert into public.payment_settings (id, active_provider, reason)
values ('SINGLETON', null, '초기값 — PG 미설정(결제 자체가 막힌 상태, 2026-09-18 확정 원칙과 동일)');

-- 행 추가/삭제 금지(system_gates_forbid_insert_delete와 같은 원칙 — "구조적으로 불가능하게").
create or replace function public.payment_settings_forbid_insert_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception '결제 설정 행은 마이그레이션으로만 추가/삭제할 수 있습니다. 상태 변경은 UPDATE만 가능합니다.'
    using errcode = 'restrict_violation';
end;
$$;

create trigger payment_settings_forbid_insert
  before insert on public.payment_settings
  for each row execute function public.payment_settings_forbid_insert_delete();

create trigger payment_settings_forbid_delete
  before delete on public.payment_settings
  for each row execute function public.payment_settings_forbid_insert_delete();

-- CLOSED든 특정 PG 선택이든 변경할 때는 사유가 필수(system_gates_checks.sql과 같은 원칙,
-- "관리자가 바꾸는 상태 전이는 방향과 무관하게 전부 사유 필수").
alter table public.payment_settings
  add constraint payment_settings_reason_required
  check (reason is not null and length(trim(reason)) > 0);

alter table public.payment_settings enable row level security;

-- 읽기/쓰기 모두 service_role만(runAdminCommand·getPaymentProvider가 admin 클라이언트로
-- 접근 — RLS 우회). anon/authenticated용 SELECT 정책은 만들지 않는다. 활성 PG를 읽는
-- 코드는 getPaymentProvider()뿐이고, 클라이언트 키가 이 테이블을 직접 읽을 경로가 없다
-- (README 7-6, 2026-09-28 반영). PG-6에서 클라이언트 컴포넌트가 직접 읽어야 할 이유가
-- 생기면 그때 정책을 추가한다. system_gates가 UPDATE 정책 없이 service_role만 쓰는 것과
-- 동일.

-- RPC — 활성 PG 변경. system_gates의 setGate() 서버 액션과 달리, 이 값은 결제 파사드가
-- 직접 SELECT로 읽으므로(작업 4) 별도 RPC 없이 admin 클라이언트의 .update()로도 되지만,
-- "감사에 필요한 필드를 빠짐없이 채운다"는 실수를 구조적으로 막기 위해 RPC로 강제한다.
create or replace function public.set_payment_provider(
  p_active_provider text,
  p_reason text,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_active_provider is not null and p_active_provider not in ('TOSS', 'PAYAPP') then
    raise exception '알 수 없는 결제 제공자: %', p_active_provider;
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception '사유를 입력해야 합니다.';
  end if;

  update public.payment_settings
  set active_provider = p_active_provider,
      reason = p_reason,
      changed_by = p_actor_id,
      changed_at = now()
  where id = 'SINGLETON';
end;
$$;

revoke execute on function public.set_payment_provider(text, text, uuid) from public, anon, authenticated;
grant execute on function public.set_payment_provider(text, text, uuid) to service_role;
