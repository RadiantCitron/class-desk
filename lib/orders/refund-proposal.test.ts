import { describe, expect, it } from "vitest";
import { buildAmountDefault, readRequestSnapshot } from "./refund-proposal";

describe("readRequestSnapshot & buildAmountDefault (A-2 순수 함수)", () => {
  describe("readRequestSnapshot", () => {
    it("payload가 없거나 객체가 아니면 null", () => {
      expect(readRequestSnapshot(null)).toBeNull();
      expect(readRequestSnapshot(undefined)).toBeNull();
      expect(readRequestSnapshot({})).toBeNull();
    });

    it("proposal이 빈 객체이거나 유효하지 않으면 null (S-5 이전 신청 대비)", () => {
      expect(readRequestSnapshot({ requested_on: "2026-10-12", proposal: {} })).toBeNull();
      expect(readRequestSnapshot({ requested_on: "2026-10-12", proposal: null })).toBeNull();
    });

    it("유효한 proposal 요약이 있으면 정상 추출", () => {
      const payload = {
        requested_on: "2026-10-12",
        reason: "개인 사정",
        proposal: {
          policyId: "2026-10-v1",
          stage: "BEFORE_START",
          eligible: true,
          amount: 7000,
          ratio: { n: 7, d: 10 },
          daysBefore: 3,
        },
      };
      const snapshot = readRequestSnapshot(payload);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.requestedOn).toBe("2026-10-12");
      expect(snapshot?.proposal).toMatchObject({
        policyId: "2026-10-v1",
        stage: "BEFORE_START",
        eligible: true,
        amount: 7000,
        daysBefore: 3,
      });
    });
  });

  describe("buildAmountDefault", () => {
    it("스냅샷이 없으면 { mode: 'none', amount: null }", () => {
      expect(buildAmountDefault(null, 10000)).toEqual({ mode: "none", amount: null });
      expect(buildAmountDefault(undefined, 10000)).toEqual({ mode: "none", amount: null });
    });

    it("스냅샷이 eligible: false이거나 금액 0 이하이면 { mode: 'none', amount: null }", () => {
      const uneligible = {
        requestedOn: "2026-10-12",
        proposal: { eligible: false, amount: 0, stage: "NOT_ALLOWED" as const },
      };
      expect(buildAmountDefault(uneligible, 10000)).toEqual({ mode: "none", amount: null });
    });

    it("제안액이 환불 가능액 이상이면 mode: 'full', amount: refundable", () => {
      const snapshot = {
        requestedOn: "2026-10-12",
        proposal: { eligible: true, amount: 10000, stage: "BEFORE_START" as const },
      };
      // 10000 >= 10000 -> full
      expect(buildAmountDefault(snapshot, 10000)).toEqual({ mode: "full", amount: 10000 });
      // 10000 >= 5000 -> full
      expect(buildAmountDefault(snapshot, 5000)).toEqual({ mode: "full", amount: 5000 });
    });

    it("제안액이 환불 가능액보다 작으면 mode: 'partial', amount: 제안액", () => {
      const snapshot = {
        requestedOn: "2026-10-12",
        proposal: { eligible: true, amount: 7000, stage: "BEFORE_START" as const },
      };
      expect(buildAmountDefault(snapshot, 10000)).toEqual({ mode: "partial", amount: 7000 });
    });
  });
});
