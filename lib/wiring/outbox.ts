import { drainOutbox, type OutboxRoutes } from "@/lib/outbox/drain";
import { onPaymentSucceeded, onPaymentRefunded, cancelOrdersForWithdrawnUser } from "@/lib/orders/handlers";
import {
  grantForPaidOrder,
  grantForAdminGrantedOrder,
  revokeForClosedOrder,
  revokeForEndedCourse,
  revokeForRefundedOrder,
  revokeAllForWithdrawnUser,
  reissueGrantsForOrder,
} from "@/lib/entitlements/handlers";

// USER_WITHDRAWN에는 이용권·주문 두 모듈이 반응한다. OutboxRoutes는
// 토픽 하나에 핸들러 하나만 걸 수 있어, 이 파일(WIRING — 여러 모듈 import가 원래 허용됨) 안에서
// 합성한다. 순서: 주문 취소를 먼저 해도, 이용권 회수를 먼저 해도 서로 독립적이라 상관없다.
async function onUserWithdrawn(payload: Record<string, unknown>) {
  await revokeAllForWithdrawnUser(payload);
  await cancelOrdersForWithdrawnUser(payload);
}

// 연동표 — "어떤 사실에 어느 모듈이 반응하는가"는 이 파일에만 있다.
// 한 줄에 하나, 로직 없음. 새 반응을 추가하려면 ① 반응하는 모듈 안에 핸들러를 만들고
// ② 여기 한 줄을 더한다. 러너(lib/outbox/drain.ts)는 이 표를 받기만 한다.
export const OUTBOX_ROUTES: OutboxRoutes = {
  // 결제 → 주문
  PAYMENT_SUCCEEDED: onPaymentSucceeded,
  PAYMENT_REFUNDED: onPaymentRefunded,
  // 주문 → 이용권
  ORDER_PAID: grantForPaidOrder,
  ORDER_ACCESS_GRANTED: grantForAdminGrantedOrder,
  ORDER_REFUNDED: revokeForRefundedOrder,
  // 주문 → 이용권(폐강 중 환불 없이 수강 종료). 폐강은 더 이상 환불을 자동 개시하지 않는다(ADR-0021).
  ORDER_CLOSED: revokeForClosedOrder,
  // 주문 → 이용권(강의 종료 시 그 강의 권한 전부 회수)
  ORDER_COURSE_ENDED: revokeForEndedCourse,
  // 개설강의 수정(디스코드 역할 교체) → 이용권 재부여
  ORDER_GRANTS_REISSUED: reissueGrantsForOrder,
  // 회원 → 이용권 + 주문
  USER_WITHDRAWN: onUserWithdrawn,
};

// 진입점(관리자 대시보드·결제 웹훅·크론)이 부르는 유일한 배치 입구.
export function runOutboxBatch() {
  return drainOutbox(OUTBOX_ROUTES);
}
