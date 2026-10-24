// 학생 홈의 폐강 배너 판정 — DB 조회 없는 순수 함수(ADR-0021).
// 폐강은 결제 완료·무료(직권 부여) 수강생을 자동으로 환불·종료하지 않고, 관리자가 학생별로 처리한다(전액 환불 / 환불 없이 종료).
// 처리가 끝난 신청은 수강 상태가 CANCELLED(또는 정리된 REJECTED)다 — 결제 상태(REFUNDED/PAID…)와 무관하다.
// 예전 판정(REFUNDED 또는 취소·반려 + UNPAID)은 「환불 없이 종료」한 결제 건(CANCELLED + PAID)을 영영 「환불 대기」로 남겼다.

export type BannerOrder = { status: string; payment_status: string };

/** 이 개설강의의 내 신청이 전부 정리됐으면(= 더 보여 줄 게 없으면) true. */
export function isCancellationSettled(orders: readonly BannerOrder[]): boolean {
  return orders.every((o) => o.status === "CANCELLED" || o.status === "REJECTED");
}

/** 아직 정리되지 않은 내 신청 중 결제했거나 무료(직권 부여)를 받은 건이 있는가 — 담당자 처리를 기다리는 중이다. */
export function awaitsStaffProcessing(orders: readonly BannerOrder[]): boolean {
  return orders.some(
    (o) =>
      (o.status === "APPROVED" || o.status === "PENDING") &&
      (o.payment_status === "PAID" || o.payment_status === "PARTIALLY_REFUNDED" || o.payment_status === "WAIVED"),
  );
}
