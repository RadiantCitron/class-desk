-- 결제 "시도"를 원장(payment_events)이 아닌 별도 테이블에 둔다(2026-10-02).
-- 토스 공식 흐름: 결제 요청 전에 서버에 주문번호를 임시로 저장하고, 성공 복귀 때 그 저장값과
-- 대조한 뒤 승인 API를 부른다. 돈이 실제로 움직이는 것은 우리 서버의 승인 호출뿐이고 그 사실과
-- 결과만 원장에 남는다. 이전에는 이 임시 저장을 원장의 PAYMENT_INITIATED로 해서 "결제 시작"
-- 표시·재결제 대기·대사 경고가 줄줄이 붙었다.
--
-- 쓰기: 결제 모듈(startCheckout)이 service_role로 INSERT만 한다. 읽기: 복귀 가드가 "이 시도 번호를
-- 우리가 발급했는지·어느 PG인지"를 확인한다. 삭제·수정 없음.

create table public.payment_attempts (
  id         uuid primary key,
  order_id   uuid not null references public.orders (id),
  provider   text not null,
  created_at timestamptz not null default now()
);

create index payment_attempts_order_created_idx
  on public.payment_attempts (order_id, created_at desc);

comment on table public.payment_attempts is
  '결제창을 연 시도(토스 주문번호의 attempt 부분). 원장이 아니다 — 돈과 무관한 임시 기록이며, 확정(성공/실패)만 payment_events에 남는다.';

alter table public.payment_attempts enable row level security;
-- 정책 없음 — service_role(admin 클라이언트)과 RLS를 우회하는 서버 쪽 읽기만. payment_checkout_claims와 동일.

-- 이미 원장에 있는 PAYMENT_INITIATED를 시도로 옮겨, 전환 시점에 결제창이 열려 있던 시도의 복귀도 처리되게 한다.
-- 원장의 기존 행은 지우지 않는다. provider_event_id가 UUID 모양인 것만 옮긴다.
insert into public.payment_attempts (id, order_id, provider, created_at)
select provider_event_id::uuid, order_id, provider, created_at
from public.payment_events
where event_type = 'PAYMENT_INITIATED'
  and order_id is not null
  and provider_event_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
on conflict (id) do nothing;
