-- payment_attempts(결제 요청 이력) 삭제 금지(설계 검토).
-- 이 표는 "우리가 PG에 결제를 요청한 기록"이라 결제 장애 확인(대사 ⑦·관리자 결제 요청 이력)의 근거다. 표 설명은 "삭제 없음"이었지만
-- DB가 막지 않아 e2e 정리 코드가 실제로 지우고 있었다(원장 payment_events는 트리거로 막혀 있었다).
-- 원장과 같은 함수를 DELETE에만 건다 — 앱 경로(anon/authenticated/service_role)는 막고, 소유자(postgres)의 직접 작업 여지는 남긴다.
-- UPDATE는 막지 않는다(승인 요청 시각 confirm_requested_at을 한 번 기록 — lib/payment/index.ts completeCheckout).

create trigger payment_attempts_forbid_app_delete
  before delete on public.payment_attempts
  for each row execute function public.event_log_forbid_app_update_delete();
