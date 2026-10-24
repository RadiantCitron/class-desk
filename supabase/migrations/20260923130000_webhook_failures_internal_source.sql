-- 서비스 오픈 전 크리티컬 수정 4단계(2026-09-23): 결제 웹훅이 어떤 경우에도 500으로
-- 죽지 않게 하기 위한 DLQ source 확장.
--
--   ⑧ app/api/webhooks/payment/route.ts가 getPaymentProvider()와 verifyWebhook()을 try 밖에서
--      호출해, PAYMENT_PROVIDER 미설정이거나 스텁(steppay)이면 웹훅이 500으로 죽고
--      webhook_failures에도 아무것도 안 남았다 — "돈은 들어왔는데 우리 쪽엔 기록도 흔적도
-- 없음"이 되는 유일한 경로였다.
--
-- 그 경우엔 provider.name을 얻을 수 없으므로 source에 넣을 값이 필요하다. payment_events.provider가
-- 이미 자체 발생 이벤트에 'INTERNAL'을 쓰고 있으므로(20260911100200_payment_ledger_rework.sql)
-- 같은 어휘를 재사용한다.
alter table public.webhook_failures drop constraint webhook_failures_source_check;
alter table public.webhook_failures add constraint webhook_failures_source_check
  check (source in ('TALLY', 'PAYAPP', 'MOCK', 'STEPPAY', 'OUTBOX', 'INTEGRITY', 'AUDIT', 'INTERNAL'));
