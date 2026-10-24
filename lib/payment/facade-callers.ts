/**
 * 결제 파사드(lib/payment/index.ts) export별 허용 호출자.
 * 나중에 경로를 바꾸려면 이 표의 접두사만 고친다.
 * 접두사는 app/ 기준, 슬래시로 끝나게 적는다.
 */
export const PAYMENT_FACADE_CALLERS = {
  startCheckout: ["app/student/payment/"],
  confirmPayment: ["app/admin/orders/"],
  ingestWebhook: ["app/api/webhooks/payment/"],
  completeCheckout: ["app/student/payment/"],
  // Code-C에서 admin orders/[id] 액션이 호출. 학생 경로는 등록하지 않음.
  // 폐강 중 선택한 학생 일괄 전액 환불(app/admin/course-offerings/[id]/refund-actions.ts)도 같은 환불 명령을 반복한다.
  // 자동 환불 옵션 켜진 강의의 학생 신청 시 app/student/ 에서 레일 명령을 거쳐 호출.
  requestRefund: ["app/admin/orders/", "app/admin/course-offerings/", "app/student/"],
  getRefundableAmount: ["app/admin/orders/", "app/admin/course-offerings/", "app/student/"],
  markRefundRequestFailed: ["app/admin/orders/"],
} as const;

export type PaymentFacadeExport = keyof typeof PAYMENT_FACADE_CALLERS;

/** lib/payment 자신·테스트는 호출자 제한 밖 */
export const PAYMENT_FACADE_CALLER_EXEMPT_PREFIXES = [
  "lib/payment/",
] as const;
