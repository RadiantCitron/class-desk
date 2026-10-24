import type { EligibilityRule } from "../types";

export const ownedBySelf: EligibilityRule = {
  code: "OWNED_BY_SELF",
  message: "본인의 수강신청 건이 아닙니다.",
  evaluate: (ctx) => ctx.actorProfileId === ctx.order.userId,
};
