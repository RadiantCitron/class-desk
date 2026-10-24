import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadEligibilityContext, evaluateEligibility } from "@/lib/guards/checkout";
import { runQuery } from "@/lib/commands/run-command";
import { checkRail } from "@/lib/commands/check";
import { PAYMENT_ORDER_NAME } from "@/lib/payment/order-name";
import { hasUnreflectedSuccess as hasUnreflectedSuccessIn, paymentEventLabel } from "@/lib/payment/ledger-view";

// page가 넘기는 값: 복귀 안내 종류(parseReturnResult 결과 또는 null)와, 실패일 때 쓸 안내 문구를 만드는 함수·표 — 모두 app/의 결제 파일에서 온다.
export type PaymentReturnInput = {
  /** parseReturnResult(r) 결과(from === "return"일 때만), 아니면 null. */
  returnResult: "failed" | "denied" | "pending" | "error" | null;
  /** RETURN_NOTICES(return-result.ts) — denied·pending·error 안내 문구 표. */
  returnNotices: Record<"denied" | "pending" | "error", string>;
  /** failureNotice(code).message를 계산하는 함수(failure-message.ts). */
  failureMessageFor: (code: string | null) => string;
};

export type PaymentView = {
  orderId: string;
  /** 이 화면 자체가 통제 스위치(시스템·결제 모듈·이 화면·이 학생 대상)로 막혔을 때의 안내 문구. 있으면 Screen은 이것만 보인다. */
  blockedMessage: string | null;
  banner:
    | { kind: "success" }
    | { kind: "notice"; tone: "info" | "warning"; text: string }
    | null;
  /** 결제 실패 복귀 팝업 문구. 있으면 Screen이 PaymentFailureDialog를 렌더한다. */
  failureMessage: string | null;
  /** 결제 이력엔 "결제 성공"이 남았는데 주문 상태는 미결제인 경우의 안내를 보일지. */
  unreflectedSuccess: boolean;
  /** 이미 결제 처리된 건이면 상태 문구, 아니면 null. */
  processedText: string | null;
  /** 미결제일 때만. */
  unpaid: null | {
    amountText: string;
    /** 결제 가능 → 위젯 값. 불가 → null. */
    widget: { amount: number; orderName: string } | null;
    failedRules: { code: string; message: string }[];
    showDiscordLink: boolean;
    showTermsLink: boolean;
  };
  events: {
    id: string;
    timeText: string;
    label: string;
    amountText: string;
    method: string;
    provider: string;
  }[];
};

function blockedPaymentView(orderId: string, message: string): PaymentView {
  return {
    orderId,
    blockedMessage: message,
    banner: null,
    failureMessage: null,
    unreflectedSuccess: false,
    processedText: null,
    unpaid: null,
    events: [],
  };
}

// 결제 자격검증의 1차 관문(UX용) — 여기서 통과해도 "결제하기"를 누르는 순간 actions.ts가 같은 규칙을 다시 확인한다(2중 방어, 2026-09-11).
// "관리자 승인 ≠ 결제 가능"의 실제 화면: status가 APPROVED라도 나머지 조건이 안 맞으면 여기서 막힌다.
export async function loadStudentPayment(orderId: string, input: PaymentReturnInput): Promise<PaymentView> {
  // 화면 통제(시스템·결제 모듈·이 화면·이 학생 대상 스위치 — 명령 레일 CR-5)에 걸리면 결제창·이력 없이 사유만 보인다.
  // 로그인 여부는 proxy.ts가 먼저 보고, 여기서는 레일 who(runQuery)가 다시 본다.
  return runQuery({ command: "STUDENT_PAYMENT_VIEW", onDenied: (denial) => blockedPaymentView(orderId, denial.message) }, async (profile) => {
    const supabase = await createClient();
    const ctx = await loadEligibilityContext(supabase, orderId, profile.id);
    if (!ctx) {
      redirect("/student");
    }

    // 업무 자격(규칙엔진) + 통제(명령 레일 — 결제 봉쇄·학생 결제 제한 등)를 함께 본다. 결제하기를 누르면 startPayment(runCommand)가
    // 같은 레일 판정으로 다시 막는다(2중 방어). 레일 사유는 "남은 조건" 목록 맨 앞에 보인다.
    const eligibility = evaluateEligibility(ctx);
    const rail = await checkRail("PAYMENT_START", profile);
    const result = rail.ok
      ? eligibility
      : { eligible: false, failedRules: [{ code: `RAIL_${rail.check}`, message: rail.message }, ...eligibility.failedRules] };

    // 결제는 성공 직후든 나중이든 항상 자세히 볼 수 있어야 한다 — UNPAID일 때도 항상 이 신청 건의 결제 이력을 함께 보여준다.
    const { data: events, error: eventsError } = await supabase
      .from("payment_events")
      .select("id, event_type, amount, currency, provider, payment_method, created_at, raw_payload")
      .eq("order_id", orderId)
      .order("created_at", { ascending: false });
    // 쿼리 에러를 조용히 버리지 않는다 — 2026-09-11에 이걸 버려서 결제 이력 표가 항상 빈 화면으로 뜨는데도 한참 안 들켰다.
    if (eventsError) console.error("결제 이력 조회 실패:", eventsError);

    // 결제 이력엔 "결제 성공"이 남았는데 주문 상태는 여전히 미결제인 경우 — 지금 상태를 있는 그대로 알리고 문의를 안내한다.
    const hasUnreflectedSuccess = hasUnreflectedSuccessIn(ctx.order.paymentStatus, events);

    // 복귀 안내는 복귀 라우트가 넘긴 이번 결과(r)로만 고른다 — 원장 최신 이벤트로 짐작하지 않는다.
    // 이미 결제가 반영됐으면(다른 탭·웹훅 등) 결과와 상관없이 성공으로 보여 준다.
    const returnResult = input.returnResult;
    const returnBanner =
      returnResult === null
        ? null
        : ctx.order.paymentStatus !== "UNPAID" || hasUnreflectedSuccess
          ? ("success" as const)
          : returnResult;
    // 실패 안내 코드는 가장 최근 "결제 실패" 원장 행의 원문에서 코드만 읽는다(원문 메시지는 화면에 안 쓴다).
    const latestFailedRaw = events?.find((e) => e.event_type === "PAYMENT_FAILED")?.raw_payload as
      | { code?: unknown }
      | null
      | undefined;
    const failureCode = typeof latestFailedRaw?.code === "string" ? latestFailedRaw.code : null;

    const banner: PaymentView["banner"] =
      returnBanner === "success"
        ? { kind: "success" }
        : returnBanner === "pending" || returnBanner === "denied" || returnBanner === "error"
          ? {
              kind: "notice",
              tone: returnBanner === "pending" ? "info" : "warning",
              text: input.returnNotices[returnBanner],
            }
          : null;

    const unpaid: PaymentView["unpaid"] =
      ctx.order.paymentStatus !== "UNPAID"
        ? null
        : {
            amountText: `결제 금액: ${ctx.order.finalAmount?.toLocaleString() ?? "-"}원`,
            widget: result.eligible ? { amount: ctx.order.finalAmount!, orderName: PAYMENT_ORDER_NAME } : null,
            failedRules: result.eligible ? [] : result.failedRules.map((rule) => ({ code: rule.code, message: rule.message })),
            showDiscordLink: !result.eligible && result.failedRules.some((r) => r.code === "DISCORD_LINKED"),
            showTermsLink: !result.eligible && result.failedRules.some((r) => r.code === "TERMS_UP_TO_DATE"),
          };

    return {
      orderId,
      blockedMessage: null,
      banner,
      failureMessage: returnBanner === "failed" ? input.failureMessageFor(failureCode) : null,
      unreflectedSuccess: hasUnreflectedSuccess,
      processedText:
        ctx.order.paymentStatus === "WAIVED"
          ? "이 신청 건은 결제 없이 수강권이 부여되었습니다(무료)."
          : ctx.order.paymentStatus !== "UNPAID"
            ? `이미 처리된 결제 건입니다(현재 상태: ${ctx.order.paymentStatus}).`
            : null,
      unpaid,
      events: (events ?? []).map((event) => ({
        id: event.id,
        timeText: new Date(event.created_at).toLocaleString("ko-KR"),
        label: paymentEventLabel(event.event_type),
        amountText: `${event.amount.toLocaleString()} ${event.currency}`,
        method: event.payment_method ?? "-",
        provider: event.provider,
      })),
    };
  });
}
