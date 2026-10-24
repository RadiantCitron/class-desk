-- 페이앱 폐기(결제모듈의 기본 골격은 유지).
-- 이 마이그레이션은 **새로 선택하는 경로만** 막는다 — 활성 PG로 'PAYAPP'을 고를 수 없게 한다.
--
-- 건드리지 않는 것(의도적):
--  · payment_events.provider CHECK · dead_letters.source CHECK의 'PAYAPP' — 과거 PAYAPP 결제·환불 행이 남아 있고
--    원장은 append-only라 지울 수 없다. 'STEPPAY'·'MOCK'과 같은 "과거 기록용" 값으로 유지한다.
--  · 이미 적용된 마이그레이션 파일(20260928100000 등) — 수정하지 않는다.
-- 새 PG를 추가할 때는 이 두 곳(payment_settings CHECK·set_payment_provider)에 값을 넣는 마이그레이션이 필요하다(원래부터 그랬다).

-- 1) 사전 검사 — 지금 활성 PG가 PAYAPP이면 중단한다(TALLY 제거 마이그레이션 20260923210000과 같은 방식).
--    중단되면 /admin/system에서 TOSS 또는 미설정으로 먼저 바꾼 뒤 다시 적용한다.
do $$
begin
  if exists (select 1 from public.payment_settings where active_provider = 'PAYAPP') then
    raise exception '활성 PG가 아직 PAYAPP입니다. /admin/system에서 TOSS 또는 미설정으로 먼저 바꾼 뒤 이 마이그레이션을 적용하세요.';
  end if;
end;
$$;

-- 2) payment_settings.active_provider CHECK — TOSS(또는 미설정 NULL)만.
alter table public.payment_settings drop constraint payment_settings_active_provider_check;
alter table public.payment_settings add constraint payment_settings_active_provider_check
  check (active_provider in ('TOSS'));

-- 3) set_payment_provider — 허용 목록에서 PAYAPP만 뺀다. 나머지(사유 필수·싱글턴 UPDATE·security definer)는 원본
--    (20260928100000_dlq소스복구와pg설정.sql)과 같다. 검사 순서(provider → 사유)도 그대로다.
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
  if p_active_provider is not null and p_active_provider not in ('TOSS') then
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
