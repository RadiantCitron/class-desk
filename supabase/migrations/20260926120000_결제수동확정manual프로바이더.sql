-- 계좌이체 등으로 실제
-- 결제를 받았거나 웹훅이 유실된 경우, 원장에 provider='MANUAL' 이벤트를 넣어 웹훅과 같은
-- 경로(on_payment_succeeded → 아웃박스 → 이용권)를 타게 한다. ADMIN 전용 D1.

alter table public.payment_events drop constraint payment_events_provider_check;
alter table public.payment_events add constraint payment_events_provider_check
  check (provider in ('PAYAPP', 'STEPPAY', 'MOCK', 'INTERNAL', 'TOSS', 'MANUAL'));
