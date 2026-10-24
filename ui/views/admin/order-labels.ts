// 관리자 화면의 주문(수강신청)·결제 상태 한글 라벨 — 개설강의 상세와 수강생 상세가 같이 쓴다.
// 학생 화면(app/student/page.tsx)은 문구가 조금 다르다("승인 대기 중", "결제완료") — 의도적으로 따로 둔다.
export const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: "승인 대기",
  APPROVED: "승인됨",
  REJECTED: "반려",
  CANCELLED: "취소",
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  UNPAID: "미결제",
  PAID: "결제 완료",
  PARTIALLY_REFUNDED: "부분 환불",
  REFUNDED: "환불 완료",
  WAIVED: "무료(직권 부여)",
};
