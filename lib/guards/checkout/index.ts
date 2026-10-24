import type { EligibilityContext, EligibilityResult } from "./types";
import { ownedBySelf } from "./rules/owned-by-self";
import { notWithdrawn } from "./rules/not-withdrawn";
import { adminApproved } from "./rules/admin-approved";
import { termsUpToDate } from "./rules/terms-up-to-date";
import { notAlreadyPaid } from "./rules/not-already-paid";
import { offeringOpen } from "./rules/offering-open";
import { amountValid } from "./rules/amount-valid";
import { profileComplete } from "./rules/profile-complete";
import { discordLinked } from "./rules/discord-linked";
import { createClient } from "@/lib/supabase/server";
import { UserFacingError } from "@/lib/errors";
import { loadEligibilityContext } from "./context";

// 조건 추가/삭제 = 이 배열에 파일 1개 + 줄 1개. 규칙 자체는 lib/guards/checkout/rules/*.ts에
// 독립된 순수함수 하나씩으로 캡슐화되어 있다.
// 여기는 결제의 "업무 자격"(주문·금액·약관·프로필·디스코드)만 평가한다. 결제 봉쇄 등 시스템 통제는
// 명령 레일(lib/commands)이 PAYMENT_START·PAYMENT_CONFIRM 단계에서 통제 스위치로 선행 차단한다.
export const RULES = [
  ownedBySelf,
  notWithdrawn,
  adminApproved,
  termsUpToDate,
  notAlreadyPaid,
  offeringOpen,
  amountValid,
  profileComplete,
  discordLinked,
];

// 첫 실패에서 멈추지 않고 전 규칙을 평가한다 — "결제하려면 남은 것: ①, ②"를 한 번에 보여주기 위함.
export function evaluateEligibility(ctx: EligibilityContext): EligibilityResult {
  const failedRules = RULES.filter((rule) => !rule.evaluate(ctx)).map((rule) => ({
    code: rule.code,
    message: rule.messageFor ? rule.messageFor(ctx) : rule.message,
  }));

  return { eligible: failedRules.length === 0, failedRules };
}

export type { EligibilityContext, EligibilityResult, EligibilityRule } from "./types";
export { loadEligibilityContext };

// 결제 시작 명령의 가드(옛 lib/payment/index.ts startCheckout 앞부분을 옮김).
// runCommand()의 3단계에서 불린다. 통과하면 결제 모듈이 쓸 값(금액·구매자 이름)이 든 컨텍스트를
// 돌려준다 — 결제 모듈은 주문·회원 테이블을 직접 읽지 않는다.
export async function assertCheckoutEligible(
  orderId: string,
  actorProfileId: string,
): Promise<EligibilityContext> {
  const supabase = await createClient();
  const ctx = await loadEligibilityContext(supabase, orderId, actorProfileId);
  if (!ctx) {
    throw new UserFacingError("신청 내역을 찾을 수 없습니다.");
  }

  const result = evaluateEligibility(ctx);
  if (!result.eligible) {
    throw new UserFacingError(
      `결제할 수 없습니다: ${result.failedRules.map((r) => r.message).join(", ")}`,
    );
  }
  return ctx;
}

// 복귀 가드 완화 대상 코드(F-9/F-5):
// - 결제 전(UNPAID) 주문: 모집 마감·약관·프로필은 시작 시 이미 통과했으므로 완화하되,
//   디스코드(DISCORD_LINKED)는 신청 시점에 확인하지 않으므로 결제 확정 직전에 반드시 확인한다.
// - 이미 결제된(PAID 등) 주문: 웹훅이 먼저 반영된 정상 복귀이므로 DISCORD_LINKED를 포함해 모두 완화한다(B9).
// 결제 봉쇄·학생 결제 제한은 여기 없다 — 명령 레일이 PAYMENT_CONFIRM을 직접 통제한다(봉쇄 제외 없음 — ADR-0015).
const BASE_RETURN_SOFTENED_CODES = new Set([
  "NOT_ALREADY_PAID",
  "OFFERING_OPEN",
  "TERMS_UP_TO_DATE",
  "PROFILE_COMPLETE",
]);

const RETURN_SOFTENED_CODES_PAID = new Set([
  ...BASE_RETURN_SOFTENED_CODES,
  "DISCORD_LINKED",
]);

export type CheckoutReturnContext = EligibilityContext & {
  providerName: "TOSS";
  attemptId: string;
};

// 복귀 가드 — 결제 시작 가드와 같되 주문 결제 상태에 따라 완화 코드를 적용한다.
import { isSameAttemptResult } from "@/lib/payment/attempt-result";

// providerName은 attemptId에 해당하는 payment_attempts.provider다. 없으면 이 주문의 최신 시도.
export async function assertCheckoutEligibleForReturn(
  orderId: string,
  actorProfileId: string,
  attemptIdFromQuery?: string | null,
): Promise<CheckoutReturnContext> {
  const supabase = await createClient();
  const ctx = await loadEligibilityContext(supabase, orderId, actorProfileId);
  if (!ctx) {
    throw new UserFacingError("신청 내역을 찾을 수 없습니다.");
  }

  const softenedCodes =
    ctx.order.paymentStatus === "UNPAID"
      ? BASE_RETURN_SOFTENED_CODES
      : RETURN_SOFTENED_CODES_PAID;

  const failedRules = RULES.filter(
    (rule) => !softenedCodes.has(rule.code) && !rule.evaluate(ctx),
  ).map((rule) => ({ code: rule.code, message: rule.message }));

  if (failedRules.length > 0) {
    throw new UserFacingError(
      `결제할 수 없습니다: ${failedRules.map((r) => r.message).join(", ")}`,
    );
  }

  let attemptQuery = supabase
    .from("payment_attempts")
    .select("id, provider")
    .eq("order_id", orderId);

  if (attemptIdFromQuery) {
    attemptQuery = attemptQuery.eq("id", attemptIdFromQuery);
  } else {
    attemptQuery = attemptQuery.order("created_at", { ascending: false }).limit(1);
  }

  const { data: attempt, error } = await attemptQuery.maybeSingle();

  if (error) {
    throw new Error(`결제 시도 조회 실패: ${error.message}`);
  }

  const provider = attempt?.provider;
  const attemptId = attempt?.id;
  if (provider !== "TOSS" || !attemptId) {
    throw new UserFacingError("이 결제 시도의 제공자를 확인할 수 없습니다.");
  }

  // F-8 2-2: 이중 결제 확정 차단
  // 주문이 이미 결제(PAID 등)되었거나 처리된 상태(WAIVED 등)인 경우:
  // 이번 복귀의 attemptId가 해당 결제를 성공시킨 시도와 일치하는지 확인.
  // 다른 시도이거나, 성공 원장이 없거나, attempt_ref가 없으면 confirm 호출 차단(거부).
  if (ctx.order.paymentStatus !== "UNPAID") {
    const { data: lastSuccess } = await supabase
      .from("payment_events")
      .select("metadata")
      .eq("order_id", orderId)
      .eq("event_type", "PAYMENT_SUCCEEDED")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const isSame = lastSuccess && isSameAttemptResult(attemptId, lastSuccess.metadata);
    if (!isSame) {
      throw new UserFacingError("이미 결제(또는 처리)된 신청입니다. 이번 결제는 승인하지 않았습니다.");
    }
  }

  return { ...ctx, providerName: provider, attemptId };
}
