// 결제 실패 복귀 안내 문구(실패하면 팝업으로 알리고 결제 페이지로 돌려보낸다).
// 토스 원문 메시지는 사용자에게 그대로 보이지 않는다 — 코드만 읽어 우리 한국어 문구로 매핑한다.
// 코드는 토스가 failUrl 쿼리로 보낸 값이다. 사용자 취소(PAY_PROCESS_CANCELED 등)는 실패가 아니라 기록·팝업 없이 조용히 복귀하므로 여기 오지 않는다.

export type FailureNotice = { message: string };

export function failureNotice(code: string | null | undefined): FailureNotice {
  if (code === "PAY_PROCESS_ABORTED") {
    return {
      message: "결제 진행 중 문제가 생겨 결제가 중단되었습니다. 아래에서 다시 시도해 주세요.",
    };
  }
  if (code === "REJECT_CARD_COMPANY") {
    return {
      message: "카드사에서 결제를 승인하지 않았습니다. 다른 카드로 다시 시도하거나 카드사에 문의해 주세요.",
    };
  }
  return {
    message: "결제에 실패했습니다. 아래에서 다시 시도하거나, 계속되면 관리자에게 문의해 주세요.",
  };
}
