import { describe, it, expect } from "vitest";
import { amountValid } from "./amount-valid";
import { makeContext } from "./test-helpers";

describe("AMOUNT_VALID", () => {
  it("final_amount가 0이면 거부한다", () => {
    expect(amountValid.evaluate(makeContext({ order: { finalAmount: 0 } }))).toBe(false);
  });

  it("final_amount가 없으면(null) 거부한다", () => {
    expect(amountValid.evaluate(makeContext({ order: { finalAmount: null } }))).toBe(false);
  });

  it("final_amount가 list_price보다 크면 거부한다(할인 계산 오류 방어)", () => {
    expect(
      amountValid.evaluate(makeContext({ order: { listPrice: 10000, finalAmount: 20000 } })),
    ).toBe(false);
  });

  it("할인규칙이 걸려있는데 그 규칙이 유효기간을 벗어났으면 거부한다", () => {
    expect(
      amountValid.evaluate(
        makeContext({ order: { discountRuleId: "rule-1" }, discountRuleValid: false }),
      ),
    ).toBe(false);
  });

  it("금액이 정상이고 할인규칙이 없거나 유효하면 통과한다", () => {
    expect(
      amountValid.evaluate(makeContext({ order: { listPrice: 10000, finalAmount: 8000 } })),
    ).toBe(true);
  });
});
