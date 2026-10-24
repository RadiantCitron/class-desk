// 결제 복귀 결과를 복귀 라우트(return/route.ts)에서 결제 페이지(page.tsx)로 넘기는 값.
// 예전엔 결과를 넘기지 않고 결제 페이지가 원장의 "최신 이벤트"로 짐작해서, 승인 전에 거부된 복귀가 영원히 "확인 중"으로 보이거나
// 지난번 실패 팝업이 다시 떴다. 라우트가 이번 복귀에서 실제로 일어난 일을 r 값으로 넘기고, 페이지는 그 값으로만 안내를 고른다.
// 성공(내 수강으로 이동)·사용자 취소(안내 없이 결제 페이지)는 여기 오지 않는다.
export const RETURN_RESULTS = ["failed", "denied", "pending", "error"] as const;
export type ReturnResult = (typeof RETURN_RESULTS)[number];
// failed  — PG 승인 실패·카드사 거절·금액 위변조 등. 원장에 결제 실패가 기록됐다.
// denied  — 우리 서버가 승인을 요청하기 전에 복귀를 거부했다(자격·시도 확인 실패). 승인을 부르지 않았으므로 청구되지 않는다.
// pending — PG가 아직 확정하지 않았다(웹훅 대기).
// error   — 처리 중 예상 못 한 오류. 승인 요청 전인지 후인지 모르므로 다시 결제하지 말라고 안내한다.

export function returnResultPath(orderId: string, result: ReturnResult): string {
  return `/student/payment/${orderId}?from=return&r=${result}`;
}

// 모르는 값(옛 링크 ?from=return 만 있는 경우 등)은 "확인 중"으로 본다.
export function parseReturnResult(value: string | undefined): ReturnResult {
  return (RETURN_RESULTS as readonly string[]).includes(value ?? "") ? (value as ReturnResult) : "pending";
}

export const RETURN_NOTICES: Record<Exclude<ReturnResult, "failed">, string> = {
  denied:
    "결제 승인을 진행하지 않았습니다(결제 조건 확인 실패). 결제는 청구되지 않았습니다. 아래 안내를 확인한 뒤 다시 시도해 주세요.",
  pending: "결제 결과를 확인하는 중입니다. 잠시 후 이 페이지를 새로고침해 주세요.",
  error:
    "결제 결과를 확인하지 못했습니다. 결제가 이미 완료됐을 수 있으니 다시 결제하지 말고, 잠시 후 이 페이지를 새로고침하거나 관리자에게 문의해 주세요.",
};

// 복귀 처리 결과 → 이동할 주소(라우트의 분기를 순수 함수로 — 단위 테스트 대상).
// threw: 예상 못 한 예외(승인 전·후 불명) / denied: 가드 거부(UserFacingError, 승인 호출 전) / done: completeCheckout 결과.
export type ReturnOutcome =
  | { kind: "threw" }
  | { kind: "denied" }
  | { kind: "done"; status: "SUCCEEDED" | "FAILED" | "PENDING" | "CANCELED" };

export function returnDestination(orderId: string, outcome: ReturnOutcome): string {
  if (outcome.kind === "threw") return returnResultPath(orderId, "error");
  if (outcome.kind === "denied") return returnResultPath(orderId, "denied");
  switch (outcome.status) {
    case "SUCCEEDED":
      return "/student?paid=1"; // 승인 성공 → 수강 조회
    case "CANCELED":
      return `/student/payment/${orderId}`; // 사용자 취소 → 안내 없이 결제 페이지
    case "FAILED":
      return returnResultPath(orderId, "failed");
    case "PENDING":
      return returnResultPath(orderId, "pending");
  }
}
