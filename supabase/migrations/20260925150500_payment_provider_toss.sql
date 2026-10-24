-- F단계. 토스페이먼츠를 결제 원장 프로바이더로 기록할 수 있게 한다.
-- 웹훅 실패 DLQ의 source는 프로바이더 이름이라, 같은 값을 dead_letters에도 연다.
-- 이벤트 타입은 추가하지 않는다(가상계좌 입금 대기는 이번 단계에서 상태를 만들지 않음).

alter table public.payment_events drop constraint payment_events_provider_check;
alter table public.payment_events add constraint payment_events_provider_check
  check (provider in ('PAYAPP', 'STEPPAY', 'MOCK', 'INTERNAL', 'TOSS'));

alter table public.dead_letters drop constraint dead_letters_source_check;
alter table public.dead_letters add constraint dead_letters_source_check
  check (source = any (array['PAYAPP', 'MOCK', 'STEPPAY', 'OUTBOX', 'INTEGRITY', 'AUDIT', 'INTERNAL', 'TOSS']));
