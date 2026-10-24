import { describe, expect, it } from "vitest";
import { failureNotice } from "./failure-message";

describe("결제 실패 안내 문구", () => {
  it("카드사 거절·중단은 각각 사유를 안내한다", () => {
    expect(failureNotice("REJECT_CARD_COMPANY").message).toContain("카드사");
    expect(failureNotice("PAY_PROCESS_ABORTED").message).toContain("중단");
  });

  it("알 수 없거나 없는 코드는 일반 실패 안내(토스 원문 비노출)", () => {
    for (const code of [null, undefined, "", "SOMETHING_NEW"]) {
      const n = failureNotice(code);
      expect(n.message).toContain("결제에 실패했습니다");
      expect(n.message).not.toContain("SOMETHING_NEW");
    }
  });
});
