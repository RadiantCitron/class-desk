import type { EligibilityRule } from "../types";

export const amountValid: EligibilityRule = {
  code: "AMOUNT_VALID",
  message: "결제 금액 정보가 올바르지 않습니다.",
  evaluate: (ctx) => {
    const { finalAmount, listPrice } = ctx.order;
    if (finalAmount === null || finalAmount <= 0) return false;
    if (listPrice !== null && finalAmount > listPrice) return false;
    if (ctx.order.discountRuleId && !ctx.discountRuleValid) return false;
    return true;
  },
};
