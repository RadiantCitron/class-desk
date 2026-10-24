import { describe, expect, it } from "vitest";
import {
  classifyBulkRefundTarget,
  parseBulkRefundAmount,
  buildBulkRefundPreview,
  BULK_REFUND_MAX_STUDENTS,
  type BulkRefundPreviewInputRow,
} from "./bulk-refund-plan";

const card = { status: "APPROVED", payment_status: "PAID", payment_method: "CARD" };

describe("폐강 일괄 환불 대상 판정", () => {
  it("승인된 카드 결제 건은 전액(amount null)·부분 모두 대상", () => {
    expect(classifyBulkRefundTarget(card, 50_000, null)).toEqual({ ok: true });
    expect(classifyBulkRefundTarget(card, 50_000, 10_000)).toEqual({ ok: true });
    expect(classifyBulkRefundTarget({ ...card, payment_status: "PARTIALLY_REFUNDED" }, 40_000, 40_000)).toEqual({ ok: true });
  });

  it("금액이 환불 가능액보다 크면 건별로 제외(가능액을 알려 준다)", () => {
    const r = classifyBulkRefundTarget(card, 30_000, 40_000);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("30,000원");
  });

  it("무료(직권 부여)·미결제·이미 종료·환불 잔액 0·카드 아님은 제외", () => {
    expect(classifyBulkRefundTarget({ ...card, payment_status: "WAIVED", payment_method: null }, 0, null).ok).toBe(false);
    expect(classifyBulkRefundTarget({ ...card, payment_status: "UNPAID" }, 0, null).ok).toBe(false);
    expect(classifyBulkRefundTarget({ ...card, status: "CANCELLED" }, 50_000, null).ok).toBe(false);
    expect(classifyBulkRefundTarget(card, 0, null)).toEqual({ ok: false, reason: "환불할 잔액이 없습니다." });
    const bank = classifyBulkRefundTarget({ ...card, payment_method: "BANK_TRANSFER" }, 50_000, null);
    expect(bank.ok === false && bank.reason).toContain("카드(PG)");
  });

  it("부분 환불 금액 입력: 양의 정수만(쉼표 허용), 나머지는 이유 반환", () => {
    expect(parseBulkRefundAmount("10000")).toEqual({ ok: true, amount: 10_000 });
    expect(parseBulkRefundAmount(" 12,000 ")).toEqual({ ok: true, amount: 12_000 });
    for (const bad of ["", "  ", "0", "-5", "1.5", "abc"]) {
      expect(parseBulkRefundAmount(bad).ok).toBe(false);
    }
  });
});

describe("buildBulkRefundPreview", () => {
  const sampleRows: BulkRefundPreviewInputRow[] = [
    {
      orderId: "ord-1",
      email: "user1@example.com",
      name: "유저1",
      paidAmount: 50_000,
      refundedAmount: 0,
      refundableAmount: 50_000,
      proposalAmount: 35_000,
      proposalReason: "개강 전 3일 전 70%",
      order: card,
    },
    {
      orderId: "ord-2",
      email: "user2@example.com",
      name: "유저2",
      paidAmount: 100_000,
      refundedAmount: 0,
      refundableAmount: 100_000,
      proposalAmount: 0,
      proposalReason: "개강 당일 환불 불가",
      order: card,
    },
    {
      orderId: "ord-3",
      email: "user3@example.com",
      name: "유저3",
      paidAmount: 50_000,
      refundedAmount: 50_000,
      refundableAmount: 0,
      proposalAmount: 0,
      proposalReason: "잔액 없음",
      order: card,
    },
    {
      orderId: "ord-4",
      email: "user4@example.com",
      name: "유저4",
      paidAmount: 50_000,
      refundedAmount: 0,
      refundableAmount: 50_000,
      proposalAmount: 50_000,
      proposalReason: "진행 중",
      hasOpenRefundRequest: true,
      order: card,
    },
  ];

  it("빈 목록이면 실패 반환", () => {
    const res = buildBulkRefundPreview([], "full");
    expect(res.ok).toBe(false);
  });

  it("30명 초과 시 에러 반환", () => {
    const manyRows: BulkRefundPreviewInputRow[] = Array.from({ length: 31 }, (_, i) => ({
      orderId: `ord-${i}`,
      email: `u${i}@example.com`,
      name: null,
      paidAmount: 10_000,
      refundedAmount: 0,
      refundableAmount: 10_000,
      proposalAmount: 10_000,
      proposalReason: "테스트",
      order: card,
    }));
    const res = buildBulkRefundPreview(manyRows, "full");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain(`${BULK_REFUND_MAX_STUDENTS}명`);
  });

  it("전액(full) 모드: 대상자의 결정액 = 환불 가능액", () => {
    const res = buildBulkRefundPreview(sampleRows, "full", { batchId: "b-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.batchId).toBe("b-1");
    expect(res.summary.totalCount).toBe(4);
    expect(res.summary.eligibleCount).toBe(2); // ord-1, ord-2
    expect(res.summary.ineligibleCount).toBe(2); // ord-3(잔액0), ord-4(열린요청)

    const r1 = res.rows.find((r) => r.orderId === "ord-1")!;
    expect(r1.eligible).toBe(true);
    expect(r1.defaultDecidedAmount).toBe(50_000);

    const r2 = res.rows.find((r) => r.orderId === "ord-2")!;
    expect(r2.eligible).toBe(true);
    expect(r2.defaultDecidedAmount).toBe(100_000);

    const r3 = res.rows.find((r) => r.orderId === "ord-3")!;
    expect(r3.eligible).toBe(false);

    const r4 = res.rows.find((r) => r.orderId === "ord-4")!;
    expect(r4.eligible).toBe(false);
    expect(r4.ineligibleReason).toContain("진행 중");

    expect(res.summary.totalDecidedAmount).toBe(150_000);
    expect(res.summary.fullCount).toBe(2);
    expect(res.summary.partialCount).toBe(0);
  });

  it("약관 제안(policy) 모드: 제안액을 기본값으로 채움 (불가 구간은 0)", () => {
    const res = buildBulkRefundPreview(sampleRows, "policy");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const r1 = res.rows.find((r) => r.orderId === "ord-1")!;
    expect(r1.defaultDecidedAmount).toBe(35_000);

    const r2 = res.rows.find((r) => r.orderId === "ord-2")!;
    expect(r2.defaultDecidedAmount).toBe(0); // 제안액이 0

    expect(res.summary.totalDecidedAmount).toBe(35_000);
    expect(res.summary.partialCount).toBe(2); // 둘 다 가능액(50k, 100k) 미만
  });

  it("같은 금액(fixed) 모드: 고정 금액으로 채우며 가능액 초과 시 제외", () => {
    const res = buildBulkRefundPreview(sampleRows, "fixed", { fixedAmount: 60_000 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const r1 = res.rows.find((r) => r.orderId === "ord-1")!;
    // 가능액 50_000 < 60_000 -> 제외
    expect(r1.eligible).toBe(false);
    expect(r1.ineligibleReason).toContain("초과");

    const r2 = res.rows.find((r) => r.orderId === "ord-2")!;
    // 가능액 100_000 >= 60_000 -> 대상
    expect(r2.eligible).toBe(true);
    expect(r2.defaultDecidedAmount).toBe(60_000);

    expect(res.summary.eligibleCount).toBe(1);
    expect(res.summary.totalDecidedAmount).toBe(60_000);
  });
});
