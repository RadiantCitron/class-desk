import type { EligibilityRule } from "../types";

export const offeringOpen: EligibilityRule = {
  code: "OFFERING_OPEN",
  message: "판매가 마감되었거나 종료된 품목입니다.",
  evaluate: (ctx) => {
    if (ctx.offering.status !== "OPEN") return false;
    // F-8 2-1: 판매 창구 = recruit_opens_at <= now < opens_at.
    // 학생 결제는 개강(opensAt) 전까지 허용. opensAt이 없으면(상품 등) endsAt을 본다.
    const now = new Date();
    if (ctx.offering.opensAt && new Date(ctx.offering.opensAt) <= now) return false;
    if (ctx.offering.endsAt && new Date(ctx.offering.endsAt) < now) return false;
    return true;
  },
  messageFor: (ctx) => {
    const now = new Date();
    if (ctx.offering.opensAt && new Date(ctx.offering.opensAt) <= now) {
      return "개강한 수업은 결제할 수 없습니다. 관리자에게 문의해 주세요.";
    }
    return "판매가 마감되었거나 종료된 품목입니다.";
  },
};
