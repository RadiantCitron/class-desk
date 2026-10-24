import { describe, expect, it } from "vitest";
import { parseReturnResult, returnDestination, returnResultPath, RETURN_NOTICES } from "./return-result";

describe("결제 복귀 결과 전달", () => {
  it("라우트가 만든 주소의 r 값을 페이지가 그대로 읽는다", () => {
    for (const r of ["failed", "denied", "pending", "error"] as const) {
      const url = new URL(`http://x${returnResultPath("o1", r)}`);
      expect(url.pathname).toBe("/student/payment/o1");
      expect(url.searchParams.get("from")).toBe("return");
      expect(parseReturnResult(url.searchParams.get("r") ?? undefined)).toBe(r);
    }
  });

  it("r이 없거나 모르는 값이면 '확인 중'으로 본다(옛 링크)", () => {
    for (const v of [undefined, "", "SUCCEEDED", "x"]) {
      expect(parseReturnResult(v)).toBe("pending");
    }
  });

  it("승인 전 거부는 청구되지 않았다고, 오류는 다시 결제하지 말라고 안내한다", () => {
    expect(RETURN_NOTICES.denied).toContain("청구되지 않았습니다");
    expect(RETURN_NOTICES.error).toContain("다시 결제하지 말고");
  });
});

describe("복귀 결과 → 이동 주소", () => {
  it("성공은 수강 조회, 취소는 안내 없는 결제 페이지", () => {
    expect(returnDestination("o1", { kind: "done", status: "SUCCEEDED" })).toBe("/student?paid=1");
    expect(returnDestination("o1", { kind: "done", status: "CANCELED" })).toBe("/student/payment/o1");
  });

  it("실패·확인 중·승인 전 거부·예외는 결제 페이지에 결과를 실어 보낸다", () => {
    expect(returnDestination("o1", { kind: "done", status: "FAILED" })).toBe("/student/payment/o1?from=return&r=failed");
    expect(returnDestination("o1", { kind: "done", status: "PENDING" })).toBe("/student/payment/o1?from=return&r=pending");
    expect(returnDestination("o1", { kind: "denied" })).toBe("/student/payment/o1?from=return&r=denied");
    expect(returnDestination("o1", { kind: "threw" })).toBe("/student/payment/o1?from=return&r=error");
  });
});
