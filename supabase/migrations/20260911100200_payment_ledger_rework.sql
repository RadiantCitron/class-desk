-- payment_events 재설계. 기존 결함 두 가지를 고친다(2026-09-11 검토)
--
-- 1. payapp_transaction_id UNIQUE가 버그였다 — 한 거래에 승인→환불 두 이벤트가 오면 두 번째를
--    DB가 거부한다("환불도 INSERT"가 물리적으로 불가능했다). 멱등키는 거래가 아니라
--    "웹훅 이벤트"에 걸어야 한다: unique(provider, provider_event_id).
-- 2. enrollment_id가 NOT NULL이라 수강신청과 무관한 단독 결제(소스코드 판매)를 담을 수 없었다.
--
-- 컬럼명도 PayApp에 박제된 상태(payapp_*)였던 것을 provider 중립적으로 바꿔 결제 어댑터
-- 패턴(lib/payment/providers/*)과 맞춘다.

alter table public.payment_events
  drop constraint payment_events_enrollment_id_fkey,
  alter column enrollment_id drop not null;

alter table public.payment_events
  add constraint payment_events_enrollment_id_fkey
    foreign key (enrollment_id) references public.enrollments (id) on delete restrict;

alter table public.payment_events
  rename column payapp_transaction_id to provider_transaction_id;

alter table public.payment_events
  drop constraint payment_events_payapp_transaction_id_key;

-- 결제 개시(PAYMENT_INITIATED, provider='INTERNAL') 시점엔 PG 쪽 거래번호가 아직 없으므로 nullable로 바꾼다.
alter table public.payment_events
  alter column provider_transaction_id drop not null;

alter table public.payment_events
  add column provider text not null default 'PAYAPP',
  add column provider_event_id text,
  add column currency text not null default 'KRW',
  add column purpose text not null default 'ENROLLMENT',
  add column metadata jsonb not null default '{}'::jsonb,
  add column user_id uuid references public.users (id) on delete restrict;

alter table public.payment_events alter column provider drop default;
alter table public.payment_events alter column purpose drop default;

-- 기존 행(전부 ENROLLMENT)은 enrollments.user_id로 채운다. enrollment_id가 nullable이 된 이후
-- 새로 생기는 PRODUCT 구매는 enrollment가 없으므로 user_id를 직접 채워야 소유자를 식별할 수 있다
-- (이 컬럼이 없으면 8절 RLS "본인 결제 이력만 조회"가 단독 구매 건에서 항상 거부된다).
update public.payment_events pe
set user_id = e.user_id
from public.enrollments e
where pe.enrollment_id = e.id and pe.user_id is null;

alter table public.payment_events
  add constraint payment_events_user_id_required
    check (user_id is not null or enrollment_id is not null);

-- 기존 행은 거래번호를 이벤트 id로도 재사용해 채운다(과거엔 거래당 이벤트 1건만 있었으므로 안전).
update public.payment_events set provider_event_id = provider_transaction_id where provider_event_id is null;
alter table public.payment_events alter column provider_event_id set not null;

alter table public.payment_events
  add constraint payment_events_provider_check check (provider in ('PAYAPP', 'STEPPAY', 'MOCK', 'INTERNAL')),
  add constraint payment_events_purpose_check check (purpose in ('ENROLLMENT', 'PRODUCT')),
  add constraint payment_events_purpose_enrollment_check
    check (purpose <> 'ENROLLMENT' or enrollment_id is not null),
  add constraint payment_events_provider_event_unique unique (provider, provider_event_id);

-- 결제 개시(재검증 통과 후 체크아웃 URL 발급) 시점도 원장에 남긴다 — provider='INTERNAL'.
alter table public.payment_events drop constraint payment_events_event_type_check;
alter table public.payment_events
  add constraint payment_events_event_type_check
    check (event_type in ('PAYMENT_INITIATED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'REFUNDED'));

-- amount=0 허용 안 함을 유지하되, INITIATED는 시도 시점이라 실제 청구 전일 수 있으므로 그대로 둔다
-- (체크아웃 생성 시점엔 final_amount를 그대로 넘기므로 0이 되는 경우는 없다 — 자격검증의
-- AMOUNT_VALID 규칙이 final_amount > 0을 이미 강제한다).

-- webhook_failures.source에 MOCK/STEPPAY 추가. 기존 TALLY 값은 과거 DLQ 데이터 보존을 위해 남긴다
-- (Tally 웹훅 라우트 자체는 이번에 삭제되지만, 이미 쌓인 DLQ 이력을 지우지 않는다).
alter table public.webhook_failures drop constraint webhook_failures_source_check;
alter table public.webhook_failures
  add constraint webhook_failures_source_check
    check (source in ('TALLY', 'PAYAPP', 'MOCK', 'STEPPAY'));

create index on public.payment_events (enrollment_id);
create index on public.payment_events (user_id);

-- "본인 결제 이력만 조회 가능" 정책을 user_id 직접 참조 경로까지 포함하도록 재작성한다
-- (기존 정책은 enrollment_id를 통해서만 소유자를 확인해 단독 구매 건을 못 봤다).
drop policy "본인 결제 이력만 조회 가능" on public.payment_events;
create policy "본인 결제 이력만 조회 가능"
  on public.payment_events for select
  using (
    auth.uid() = user_id
    or exists (
      select 1 from public.enrollments e
      where e.id = payment_events.enrollment_id and e.user_id = auth.uid()
    )
  );
