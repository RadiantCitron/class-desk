import type { EligibilityRule } from "../types";

export const termsUpToDate: EligibilityRule = {
  code: "TERMS_UP_TO_DATE",
  message: "최신 약관에 동의해야 합니다.",
  evaluate: (ctx) => ctx.termsUpToDate,
};
