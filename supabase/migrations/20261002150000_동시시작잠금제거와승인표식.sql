-- 단계 3 (2026-10-02).
-- 1) 동시 시작 잠금(payment_checkout_claims·claim_checkout_attempt·release_checkout_claim)을 없앤다.
--    잠금은 "PG 체크아웃 세션이 중복 생성되는 것"을 막으려던 것인데, 토스 결제창형은 시작 때 서버가 PG를 부르지
--    않고(값만 만든다) 시도마다 토스 주문번호가 달라, 동시에 두 번 시작돼도 무해하다. 이중 승인은 on_payment_succeeded가
--    DLQ로 막는다. 임시 잠금 행뿐이라 지워도 이력 손실이 없다(원장·시도 테이블은 그대로).
-- 2) payment_attempts에 confirm_requested_at을 추가한다 — 우리 서버가 PG 승인(confirm)을 요청하기 직전의 시각.
--    대사 ⑦이 "승인을 요청했는데 원장에 결과가 없는" 주문만 경고하는 데 쓴다(창만 닫고 포기한 시도는 이 값이 비어 있다).

alter table public.payment_attempts add column confirm_requested_at timestamptz;

comment on column public.payment_attempts.confirm_requested_at is
  '우리 서버가 PG 승인 API를 부르기 직전 시각. null이면 승인 요청까지 가지 않은 시도(창 닫기·취소 등). 대사 ⑦ 입력.';

create index payment_attempts_confirm_idx
  on public.payment_attempts (confirm_requested_at)
  where confirm_requested_at is not null;

drop function public.claim_checkout_attempt(uuid, uuid);
drop function public.release_checkout_claim(uuid, uuid);
drop table public.payment_checkout_claims;
