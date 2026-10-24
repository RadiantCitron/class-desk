import type { EligibilityRule } from "../types";

export const profileComplete: EligibilityRule = {
  code: "PROFILE_COMPLETE",
  message: "이름·전화번호를 내 정보에서 먼저 입력해 주세요.",
  evaluate: (ctx) => !!ctx.user.name && !!ctx.user.phone,
};
