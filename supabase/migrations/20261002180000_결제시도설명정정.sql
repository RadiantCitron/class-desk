-- payment_attempts의 DB 설명을 실제 동작에 맞게 고친다(설계 검토).
-- 20261002140000의 설명은 "결제창을 연 시도"였으나, 실제로는 구매자가 토스 결제창 안의 "결제하기"를 눌러 우리 코드가
-- PG에 결제를 요청할 때(서버 액션 startPayment → startCheckout) 만든다 — 결제창을 열기만 하고 닫으면 행이 없다.
-- 또 20261002150000부터 승인 요청 시각(confirm_requested_at)을 한 번 UPDATE한다(그 외 수정·삭제 없음).
-- 동작·데이터는 바꾸지 않는다(설명만).

comment on table public.payment_attempts is
  '결제 요청(우리가 PG에 결제를 요청한 시도). 구매자가 결제창 안의 "결제하기"를 누르면 만든다 — 창을 열고 닫기만 하면 행이 없다. id 앞 8자리는 토스 주문번호의 시도 부분. 원장이 아니다(돈의 사실은 payment_events). 수정은 confirm_requested_at 한 번뿐, 삭제 금지.';

comment on column public.payment_attempts.confirm_requested_at is
  '우리 서버가 이 시도로 PG 승인 API를 처음 요청한 시각(복귀 처리 중 기록, 한 번만). null이면 승인 요청까지 가지 않은 시도(창 닫기·취소·실패 복귀 등). 대사 ⑦ 입력.';
