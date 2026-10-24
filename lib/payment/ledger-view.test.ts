import { describe, expect, it } from "vitest";
import {
  findOpenRefundRequest,
  hasUnreflectedSuccess,
  isRefundRequestClosed,
  latestRefundRequest,
  paymentEventLabel,
} from "./ledger-view";

// 화면 3곳·파사드·대사 ⑧이 같은 판정과 라벨을 쓴다.
const ev = (id: string, event_type: string, created_at: string) => ({ id, event_type, created_at });

describe("원장 해석 공용 함수", () => {
  it("라벨: 환불 요청 계열도 한국어, 모르는 값은 코드 그대로", () => {
    expect(paymentEventLabel("REFUND_REQUESTED")).toBe("환불 요청");
    expect(paymentEventLabel("REFUND_REQUEST_FAILED")).toBe("환불 요청 실패");
    expect(paymentEventLabel("REFUNDED")).toBe("환불");
    expect(paymentEventLabel("PAYMENT_INITIATED")).toContain("이전 기록");
    expect(paymentEventLabel("NEW_TYPE")).toBe("NEW_TYPE");
  });

  it("열린 환불 요청 = 가장 최근 요청이 아직 닫히지 않은 것", () => {
    const r1 = ev("r1", "REFUND_REQUESTED", "2026-10-02T10:00:00.000+00:00");
    const done = ev("d1", "REFUNDED", "2026-10-02T10:01:00.000+00:00");
    const r2 = ev("r2", "REFUND_REQUESTED", "2026-10-02T10:02:00.000+00:00");
    expect(findOpenRefundRequest([r1])?.id).toBe("r1");
    expect(findOpenRefundRequest([r1, done])).toBeNull();
    expect(findOpenRefundRequest([r1, done, r2])?.id).toBe("r2");
    expect(latestRefundRequest([r2, r1])?.id).toBe("r2");
    expect(findOpenRefundRequest([])).toBeNull();
  });

  it("요청과 같은 시각의 닫는 이벤트는 닫힌 것으로 보지 않는다(엄격히 뒤여야)", () => {
    const r = ev("r", "REFUND_REQUESTED", "2026-10-02T10:00:00.000+00:00");
    expect(isRefundRequestClosed(r, [ev("f", "REFUND_REQUEST_FAILED", "2026-10-02T10:00:00.000+00:00")])).toBe(false);
    expect(isRefundRequestClosed(r, [ev("f", "REFUND_REQUEST_FAILED", "2026-10-02T10:00:00.000001+00:00")])).toBe(true);
  });

  it("결제 성공이 있는데 미결제면 미반영", () => {
    expect(hasUnreflectedSuccess("UNPAID", [{ event_type: "PAYMENT_SUCCEEDED" }])).toBe(true);
    expect(hasUnreflectedSuccess("PAID", [{ event_type: "PAYMENT_SUCCEEDED" }])).toBe(false);
    expect(hasUnreflectedSuccess("UNPAID", [{ event_type: "PAYMENT_FAILED" }])).toBe(false);
    expect(hasUnreflectedSuccess("UNPAID", null)).toBe(false);
  });
});
