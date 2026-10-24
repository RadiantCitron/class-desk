import type { EligibilityRule } from "../types";

export const notWithdrawn: EligibilityRule = {
  code: "NOT_WITHDRAWN",
  message: "탈퇴한 계정은 결제할 수 없습니다.",
  evaluate: (ctx) => ctx.user.withdrawnAt === null,
};
