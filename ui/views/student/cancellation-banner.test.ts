import { describe, expect, it } from "vitest";
import { awaitsStaffProcessing, isCancellationSettled } from "./cancellation-banner";

describe("폐강 배너 판정", () => {
  it("전액 환불된 신청(CANCELLED + REFUNDED)은 정리됨", () => {
    expect(isCancellationSettled([{ status: "CANCELLED", payment_status: "REFUNDED" }])).toBe(true);
  });

  it("환불 없이 종료한 결제 건(CANCELLED + PAID)도 정리됨 — 예전 판정은 영영 환불 대기로 남겼다", () => {
    expect(isCancellationSettled([{ status: "CANCELLED", payment_status: "PAID" }])).toBe(true);
    expect(isCancellationSettled([{ status: "CANCELLED", payment_status: "PARTIALLY_REFUNDED" }])).toBe(true);
    expect(isCancellationSettled([{ status: "CANCELLED", payment_status: "WAIVED" }])).toBe(true);
  });

  it("결제 전 정리(REJECTED·CANCELLED + UNPAID)는 정리됨", () => {
    expect(isCancellationSettled([{ status: "REJECTED", payment_status: "UNPAID" }])).toBe(true);
    expect(isCancellationSettled([{ status: "CANCELLED", payment_status: "UNPAID" }])).toBe(true);
  });

  it("승인된 결제 건·직권 부여 건이 남아 있으면 정리 안 됨, 담당자 처리 대기", () => {
    const orders = [{ status: "APPROVED", payment_status: "PAID" }];
    expect(isCancellationSettled(orders)).toBe(false);
    expect(awaitsStaffProcessing(orders)).toBe(true);
    expect(awaitsStaffProcessing([{ status: "APPROVED", payment_status: "WAIVED" }])).toBe(true);
    expect(awaitsStaffProcessing([{ status: "APPROVED", payment_status: "PARTIALLY_REFUNDED" }])).toBe(true);
  });

  it("정리된 건만 있으면 담당자 처리 대기가 아니다", () => {
    expect(awaitsStaffProcessing([{ status: "CANCELLED", payment_status: "PAID" }])).toBe(false);
    expect(awaitsStaffProcessing([{ status: "APPROVED", payment_status: "UNPAID" }])).toBe(false);
  });
});
