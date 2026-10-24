-- 트랜잭션 아웃박스. "결제는 됐는데 권한 부여를 깜빡했다"를 원천 차단하기 위해, 결제 원장에
-- 쓰는 동일 트랜잭션 안에서 후속 작업을 함께 기록해둔다(record_payment_event(), 다음 마이그레이션).
-- 상주 소비자 프로세스는 두지 않는다(사용자 명시: "별개의 프로세스는 필요없다") — 대신
-- ① 웹훅 응답 직후 ② 관리자 대시보드 렌더 시 ③ /api/cron/outbox(엔드포인트만, 배선은 나중)
-- 세 지점에서 lib/outbox/drain.ts가 미처리 메시지를 드레인한다.

create table public.outbox_messages (
  id uuid primary key default gen_random_uuid(),
  topic text not null check (topic in ('GRANT_ENTITLEMENTS')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now()
);

alter table public.outbox_messages enable row level security;

create policy "관리자만 조회 가능"
  on public.outbox_messages for select
  using (is_admin());

-- insert/update는 서버(트랜잭션 함수/드레인 워커)가 service_role로만 수행한다.

create index on public.outbox_messages (next_attempt_at) where processed_at is null;
