import type { EligibilityRule } from "../types";

export const notAlreadyPaid: EligibilityRule = {
  code: "NOT_ALREADY_PAID",
  message: "이미 결제가 완료된 건입니다.",
  evaluate: (ctx) => ctx.order.paymentStatus === "UNPAID",
};
