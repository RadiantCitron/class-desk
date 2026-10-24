import type { EligibilityRule } from "../types";

// "수강신청 승인 ≠ 결제 가능"의 핵심 규칙. 관리자가 신청을 승인(ENROLLED)해야만 결제를 시작할
// 수 있다 — 승인은 사람의 의사결정, 이 규칙 평가는 그 결정을 매 요청 다시 확인하는 기계적 체크다.
export const adminApproved: EligibilityRule = {
  code: "ADMIN_APPROVED",
  message: "관리자의 수강 승인이 필요합니다.",
  evaluate: (ctx) => ctx.order.status === "APPROVED",
};
