import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { runQuery } from "@/lib/commands/run-command";
import { checkRail } from "@/lib/commands/check";
import { one } from "@/lib/supabase/relations";
import { listOrderAuditLogs } from "@/lib/audit/read";
import { loadEligibilityContext, evaluateEligibility } from "@/lib/guards/checkout";
import { hasConsumedDigitalProduct } from "@/lib/guards/digital-refund";
import { pgOrderIdForAttempt, resultForAttempt } from "@/lib/payment/attempt-result";
import {
  findOpenRefundRequest,
  hasUnreflectedSuccess as hasUnreflectedSuccessIn,
  paymentEventLabel,
  STALE_OPEN_REFUND_MINUTES,
} from "@/lib/payment/ledger-view";
import { canProposeRefund, evaluateRefund } from "@/lib/shared/refund-policy";
import { todayKst } from "@/lib/shared/session-progress";
import { orderEndLabel } from "@/lib/shared/order-end-label";
import {
  describeSnapshot,
  findOpenStudentRefundRequest,
  requestAgeDays,
  requestAgeLevel,
  type OrderEventLike,
  type RequestAgeLevel,
} from "@/lib/shared/refund-request";
import { buildAmountDefault, readRequestSnapshot, type AmountDefault, type RequestSnapshot } from "@/lib/orders/refund-proposal";

export type TimelineKind = "ORDER" | "PAYMENT" | "OUTBOX" | "DLQ" | "ENTITLEMENT" | "AUDIT";

const KIND_LABELS: Record<TimelineKind, string> = {
  ORDER: "주문",
  PAYMENT: "결제",
  OUTBOX: "아웃박스",
  DLQ: "DLQ",
  ENTITLEMENT: "이용권",
  AUDIT: "관리",
};

/** 관리자 환불 패널에 보이는 약관 기준 제안. */
export type RefundProposalView = {
  headline: string;
  detail: string;
  notice: string;
  policyNote: string | null;
  eligible: boolean;
  amount: number;
  suggestedPartialAmount: number | null;
};

/** 수강생 신청 시점 제안 스냅샷 뷰 모델. */
export type SnapshotView = {
  requestedOn: string | null;
  amount: number | null;
  text: string;
};

/** 승인 화면 기본 환불 범위/금액 뷰 모델. */
export type AmountDefaultView = {
  mode: "full" | "partial" | "none";
  amount: number | null;
};

/** 수강생의 열린 환불 신청 — ADMIN만. 신청 시점의 제안과 지금 기준 제안을 함께 보인다(어느 쪽으로 환불할지는 관리자 재량). */
export type RefundRequestView = {
  requestedOn: string | null;
  reason: string;
  ageDays: number;
  level: RequestAgeLevel;
  ageText: string;
  /** 신청 시점에 서버가 계산해 저장한 제안(없으면 null). */
  atRequestText: string | null;
  /** 지금(화면을 보는 날) 기준 제안 — 환불 패널의 제안과 같은 문구. */
  currentText: string | null;
  /** 신청 시점 제안 스냅샷 뷰 모델. */
  snapshot: SnapshotView | null;
  /** 약관상 불가 구간 신청 여부. */
  isNotAllowedSection: boolean;
};



export type OrderDetailView =
  | { kind: "notFound" }
  | {
      kind: "ok";
      isAdmin: boolean;
      orderId: string;
      itemLabel: string;
      buyerEmail: string;
      statusCode: string;
      /** 어떻게 끝났는지(「수강 포기(미수강)」 등). 해당 없으면 null. */
      endLabel: string | null;
      /** 열린 환불 신청(ADMIN만). */
      refundRequest: RefundRequestView | null;
      paymentStatusCode: string;
      /** "0원 — 폐강으로 종료" | "환불 반영" | "직권 부여(결제 없음)" | null */
      paymentStatusBadge: string | null;
      /** 부분환불일 때만 "(N원 환불됨)" */
      refundedText: string | null;
      amountText: string;
      createdText: string;
      unreflectedSuccess: boolean;
      /** ADMIN이고 결제 불가 사유가 있을 때만(CS-A). */
      eligibilityFailures: { code: string; message: string }[] | null;
      canConfirmManually: boolean;
      /** ADMIN이고 승인됐지만 미결제인 신청 — 결제 없이 수강권을 줄 수 있다. 폐강 진행·완료 강의는 false. */
      canGrantAccess: boolean;
      /** 디스코드 강의인데 수강생이 미연결인 경우 직권 부여/수동 결제 확인 폼 경고 문구 */
      discordWarning: string | null;
      /** ADMIN이고 폐강 진행 중인 강의의 승인된 신청 — 환불 없이 수강을 종료할 수 있다. 부분 환불·PG 외 환불 뒤 마무리에도 쓴다. */
      canCloseWithoutRefund: boolean;
      /** ADMIN이고 취소된 주문이며 잔액이 남아있고 아직 마무리 결정이 안 된 주문 */
      canDecideNoRefund: boolean;
      /** ADMIN만. 환불 가능액이 0이어도 그린다(전액 PG 외 환불 직후 결과 팝업을 남기려고 — U-4, 2026-10-02). */
      refund: {
        originalPaymentMethod: string | null;
        refundableAmount: number;
        requestKey: string;
        formKey: string;
        openRequest: { id: string; amount: number; createdText: string; stale: boolean } | null;
        isOrphanPayment: boolean;
        orphanKind: "UNPAID_ORPHAN" | "CLOSED_ORDER" | null;
        /** 이 주문에서 디지털 파일을 이미 내려받았는가 — 환불은 막지 않고 경고만. */
        digitalConsumed: boolean;
        /** 약관 기준 환불 제안 — 승인됨+결제완료 수업 주문만. 없으면 null. 제안일 뿐 환불을 막지 않는다. */
        proposal: RefundProposalView | null;
        /** 학생 신청 시점의 제안 스냅샷 뷰 모델 — 열린 신청이 없으면 null. */
        requestSnapshot: SnapshotView | null;
        /** 승인 화면의 기본 환불 금액 및 모드. */
        amountDefault: AmountDefaultView;
      } | null;


      timeline: { id: string; kind: TimelineKind; kindLabel: string; label: string; detail: string; timeText: string }[];
      /** ADMIN만(RLS) — 매니저는 null. */
      attempts:
        | { id: string; timeText: string; pgOrderId: string; provider: string; confirmText: string; resultText: string }[]
        | null;
    };

type TimelineItem = {
  id: string;
  createdAt: string;
  kind: TimelineKind;
  label: string;
  detail: string;
};

// 주문 하나의 비즈니스 트랜잭션을 한 화면에서 본다(CS-A·CS-C 해소). 수강생 상세의 타임라인 패턴을 그대로 따른다.
// deps.getRefundableAmount: 결제 파사드 함수. ui/views는 파사드를 import할 수 없다(facade-boundary.guard F-16 — 이 함수는 서비스 키로 원장을 읽어 허용 호출자가 app/admin/orders/로 고정돼 있다)
// → page가 넘기고, 이 Loader가 ADMIN일 때만 호출한다(매니저에게 서비스 키 읽기를 하지 않기 위해, 호출 조건은 반드시 이 안에 둔다).
// 이 Loader 한 곳만 인자로 받는 예외다. 되돌리는 법: 가드가 ui/views를 허용하게 바뀌면 여기서 직접 import하고 deps 인자와 page의 전달을 지운다.
export async function loadAdminOrderDetail(
  orderId: string,
  deps: { getRefundableAmount: (orderId: string) => Promise<number> },
): Promise<OrderDetailView> {
  return runQuery({ command: "ADMIN_ORDER_DETAIL_VIEW" }, async (profile) => {
    const isAdmin = profile.role === "ADMIN";

    const supabase = await createClient();

    const { data: order } = await supabase
      .from("orders")
      .select(
        "id, user_id, status, payment_status, payment_method, list_price, final_amount, refunded_amount, created_at, approved_at, course_offering_id, product_id, refund_policy_version, users(email, name), course_offerings(label, status, courses(name), course_sessions(session_date, start_time, end_time, deactivated_at)), products(name)",
      )
      .eq("id", orderId)
      .maybeSingle();

    if (!order) {
      return { kind: "notFound" };
    }

    const itemLabel = order.course_offering_id
    ? `${one(one(order.course_offerings)?.courses)?.name ?? ""}${
      one(order.course_offerings)?.label ? ` (${one(order.course_offerings)?.label})` : ""
    }`
    : (one(order.products)?.name ?? "-");

    // 주문 이벤트·결제 이력·아웃박스·DLQ·이용권·감사 로그·결제 요청 이력은 RLS가 ADMIN(과 본인)만 허용한다 — 매니저가 조회하면 조용히 빈 목록이 와서
    // "기록이 없다"로 오해한다. 그래서 ADMIN일 때만 조회하고 화면에서 따로 안내한다.
    const adminOnly = <T,>(query: PromiseLike<{ data: T | null }>) =>
      isAdmin ? query : Promise.resolve({ data: null as T | null });

    const [
      { data: orderEvents },
      { data: paymentEvents },
      { data: outboxMessages },
      { data: deadLetters },
      { data: entitlements },
      auditLogs,
      { data: paymentAttempts },
    ] = await Promise.all([
      adminOnly(
        supabase
          .from("order_events")
          .select("id, event_type, actor, created_at, payload")
          .eq("order_id", orderId)
          .order("created_at", { ascending: false }),
      ),
      adminOnly(
        supabase
          .from("payment_events")
          .select("id, event_type, provider, amount, currency, created_at, metadata")
          .eq("order_id", orderId)
          .order("created_at", { ascending: false }),
      ),
      // outbox_messages/dead_letters는 payload(jsonb)에 order_id를 담는다. 알려진 한계(R-DLQ-SCOPE): 웹훅 서명 검증처럼 order_id를 알기 전에 실패한 DLQ는 이 필터로 안 잡힌다.
      adminOnly(
        supabase
          .from("outbox_messages")
          .select("id, topic, processed_at, attempts, last_error, created_at")
          .contains("payload", { order_id: orderId })
          .order("created_at", { ascending: false }),
      ),
      adminOnly(
        supabase
          .from("dead_letters")
          .select("id, source, error_message, resolved, resolution_reason, created_at")
          .contains("payload", { order_id: orderId })
          .order("created_at", { ascending: false }),
      ),
      adminOnly(
        supabase
          .from("entitlements")
          .select("id, access_code, revoked_at, granted_at")
          .eq("order_id", orderId)
          .order("granted_at", { ascending: false }),
      ),
      isAdmin ? listOrderAuditLogs(supabase, orderId) : Promise.resolve({ data: null }),
      // 결제 요청 이력(PG 호출 기록) — 결제 이력(원장)과 다른 기록이다. RLS가 ADMIN(과 본인)만 허용하므로 ADMIN일 때만 조회한다.
      isAdmin
        ? supabase
            .from("payment_attempts")
            .select("id, provider, created_at, confirm_requested_at")
            .eq("order_id", orderId)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: null }),
    ]);

    // 그 시도의 결과가 결제 이력(원장)에 생겼는지 — 대사 ⑦과 같은 규칙(시도 단위, lib/payment/attempt-result.ts).
    const attemptRows = (paymentAttempts ?? []).map((a) => ({
      ...a,
      pgOrderId: pgOrderIdForAttempt(a.provider, orderId, a.id),
      result: resultForAttempt(a, paymentEvents ?? []),
    }));

    // CS-A — 자격검증 실패 사유(학생 화면과 같은 로직 재사용). actorProfileId를 주문 소유자(order.user_id)로 넣어야 OWNED_BY_SELF가 통과하고 나머지 진짜 실패 사유가 보인다.
    // 매니저 세션은 약관 동의·이용 제한을 RLS로 못 읽어 판정이 틀리게 나온다 — ADMIN일 때만 판정하고 매니저에겐 안내만.
    const eligibilityCtx = isAdmin ? await loadEligibilityContext(supabase, orderId, order.user_id) : null;
    // 통제(명령 레일)도 학생 입장에서 함께 본다 — 결제 봉쇄·이 학생의 결제 제한이 걸려 있으면 그 사유가 맨 앞에 보인다.
    // 주문 소유자는 학생이고 결제 시작의 역할 조건은 "탈퇴하지 않은 계정"이라, 역할은 STUDENT로 두고 탈퇴 여부만 실제 값을 쓴다.
    const ownerRail = eligibilityCtx
      ? await checkRail("PAYMENT_START", {
          id: order.user_id,
          role: "STUDENT",
          permissions: { viewStudents: false, approveOrders: false, approvePayments: false },
          withdrawnAt: eligibilityCtx.user.withdrawnAt,
        })
      : null;
    const ruleResult = eligibilityCtx ? evaluateEligibility(eligibilityCtx) : null;
    const eligibility =
      ruleResult && ownerRail && !ownerRail.ok
        ? { eligible: false, failedRules: [{ code: `RAIL_${ownerRail.check}`, message: ownerRail.message }, ...ruleResult.failedRules] }
        : ruleResult;

    // CS-C — 상태-원장 불일치(학생 결제 화면의 hasUnreflectedSuccess와 같은 판정).
    const hasUnreflectedSuccess = hasUnreflectedSuccessIn(order.payment_status, paymentEvents);

    const canConfirmManually = isAdmin && order.status === "APPROVED" && order.payment_status === "UNPAID";
    const offeringStatus = one(order.course_offerings)?.status;
    const canGrantAccess =
      canConfirmManually && offeringStatus !== "CANCELLING" && offeringStatus !== "CANCELLED";
    const canCloseWithoutRefund = isAdmin && order.status === "APPROVED" && offeringStatus === "CANCELLING";

    const refundableAmount = isAdmin ? await deps.getRefundableAmount(orderId) : 0;
    const digitalConsumed = isAdmin ? await hasConsumedDigitalProduct(orderId) : false;
    const open = isAdmin ? findOpenRefundRequest(paymentEvents ?? []) : null;
    const openRequest = open
      ? {
          id: open.id,
          amount: open.amount,
          createdText: new Date(open.created_at).toLocaleString("ko-KR"),
          stale: Date.now() - Date.parse(open.created_at) >= STALE_OPEN_REFUND_MINUTES * 60_000,
        }
      : null;
    // 약관 기준 환불 제안: 같은 순수 함수(lib/shared/refund-policy.ts)로 계산한다. 모르는 정책 버전이면 제안 대신 안내만 보인다.
    const refundProposalView = (): RefundProposalView | null => {
      if (!canProposeRefund(order) || order.final_amount === null) return null;
      try {
        const p = evaluateRefund({
          paid: order.final_amount,
          refundable: refundableAmount,
          listPrice: order.list_price,
          sessions: one(order.course_offerings)?.course_sessions ?? [],
          today: todayKst(),
          policyId: order.refund_policy_version,
        });
        return {
          headline: p.headline,
          detail: p.detail,
          notice: p.notice,
          policyNote: p.policyNote,
          eligible: p.eligible,
          amount: p.amount,
          // 부분 금액 칸의 기본값 — 제안이 있고 환불 가능액보다 작을 때만(가능액 이상이면 「전액」 기본 선택으로 충분하다).
          suggestedPartialAmount: p.eligible && p.amount > 0 && p.amount < refundableAmount ? p.amount : null,
        };
      } catch (err) {
        return {
          headline: "약관 기준 제안을 계산하지 못했습니다",
          detail: err instanceof Error ? err.message : "알 수 없는 오류",
          notice: "제안 없이도 환불은 가능합니다. 금액을 직접 정하세요.",
          policyNote: null,
          eligible: false,
          amount: 0,
          suggestedPartialAmount: null,
        };
      }
    };

    const orphanKind: "UNPAID_ORPHAN" | "CLOSED_ORDER" | null =
      !isAdmin || refundableAmount <= 0
        ? null
        : order.payment_status === "UNPAID"
          ? "UNPAID_ORPHAN"
          : order.status === "CANCELLED"
            ? "CLOSED_ORDER"
            : null;

    const isOrphanPayment = orphanKind !== null;

    const paymentStatusBadge =
      order.payment_status === "REFUNDED" && order.refunded_amount === 0
        ? "0원 — 폐강으로 종료"
        : order.payment_status === "REFUNDED" || order.payment_status === "PARTIALLY_REFUNDED"
          ? "환불 반영"
          : order.payment_status === "WAIVED"
            ? "직권 부여(결제 없음)"
            : null;

    const orderEventLikes: OrderEventLike[] = (orderEvents ?? []).map((e) => ({
      id: e.id,
      event_type: e.event_type,
      payload: (e.payload ?? null) as Record<string, unknown> | null,
      created_at: e.created_at,
    }));
    const openStudentRequest = isAdmin ? findOpenStudentRefundRequest(orderEventLikes, order.status) : null;
    const currentProposal = isAdmin ? refundProposalView() : null;
    const requestSnapshot = openStudentRequest ? readRequestSnapshot(openStudentRequest.payload) : null;
    const amountDefault = buildAmountDefault(requestSnapshot, refundableAmount);

    const refundSnapshotView: SnapshotView | null =
      requestSnapshot && requestSnapshot.proposal
        ? {
            requestedOn: requestSnapshot.requestedOn,
            amount: typeof requestSnapshot.proposal.amount === "number" ? requestSnapshot.proposal.amount : null,
            text: describeSnapshot(requestSnapshot.proposal),
          }
        : null;

    const amountDefaultView: AmountDefaultView = {
      mode: amountDefault.mode,
      amount: amountDefault.amount,
    };

    const refundRequestView: RefundRequestView | null = openStudentRequest
      ? (() => {
          const payload = openStudentRequest.payload ?? {};
          const ageDays = requestAgeDays(openStudentRequest.created_at);
          const isNotAllowedSection =
            requestSnapshot?.proposal?.eligible === false ||
            requestSnapshot?.proposal?.stage === "NOT_ALLOWED";
          return {
            requestedOn: typeof payload.requested_on === "string" ? payload.requested_on : null,
            reason: typeof payload.reason === "string" ? payload.reason : "-",
            ageDays,
            level: requestAgeLevel(ageDays),
            ageText: ageDays === 0 ? "오늘 신청" : `신청 ${ageDays}일 경과`,
            atRequestText: refundSnapshotView ? `신청 시점 제안: ${refundSnapshotView.text}` : null,
            currentText: currentProposal ? `지금 기준: ${currentProposal.headline}` : null,
            snapshot: refundSnapshotView,
            isNotAllowedSection,
          };
        })()
      : null;



    const timeline: TimelineItem[] = [
      ...(orderEvents ?? []).map((e) => ({
        id: `order-${e.id}`,
        createdAt: e.created_at,
        kind: "ORDER" as const,
        label:
          e.event_type === "ACCESS_GRANTED"
            ? "주문 이벤트: 직권 수강 부여(ACCESS_GRANTED)"
            : e.event_type === "REFUND_REQUESTED"
              ? "주문 이벤트: 수강생 환불 신청(REFUND_REQUESTED)"
              : e.event_type === "REFUND_REQUEST_REJECTED"
                ? "주문 이벤트: 환불 신청 거절(REFUND_REQUEST_REJECTED)"
                : e.event_type === "SCHEDULE_CHANGE_NOTICE"
                  ? "주문 이벤트: 일정 변경 안내(SCHEDULE_CHANGE_NOTICE)"
                  : e.event_type === "SCHEDULE_CHANGE_ACCEPTED"
                    ? "주문 이벤트: 일정 변경 동의(SCHEDULE_CHANGE_ACCEPTED)"
                    : e.event_type === "SCHEDULE_CHANGE_DECLINED"
                      ? "주문 이벤트: 일정 변경에 동의하지 않음(SCHEDULE_CHANGE_DECLINED)"
                      : e.event_type === "REFUND_APPLIED"
                        ? "주문 이벤트: 환불 반영(REFUND_APPLIED)"
                        : `주문 이벤트: ${e.event_type}`,
        detail:
          e.event_type === "ACCESS_GRANTED" || e.event_type === "REFUND_REQUESTED" || e.event_type === "REFUND_REQUEST_REJECTED" || e.event_type === "SCHEDULE_CHANGE_NOTICE"
            ? `행위자: ${e.actor} · 사유: ${(e.payload as { reason?: string } | null)?.reason ?? "-"}`
            : e.event_type === "REFUND_APPLIED"
              ? `행위자: ${e.actor} · 원인: ${(e.payload as { cause?: string } | null)?.cause ?? "-"} · 환불액: ${((e.payload as { refund_amount?: number } | null)?.refund_amount ?? 0).toLocaleString()}원 · 사유: ${(e.payload as { reason?: string } | null)?.reason ?? "-"}`
              : e.event_type === "CANCELLED" && (e.payload as { cause?: string } | null)?.cause
                ? `행위자: ${e.actor} · 원인: ${(e.payload as { cause?: string }).cause} · 지난 회차 ${(e.payload as { past_sessions?: number }).past_sessions ?? "-"}/${(e.payload as { total_sessions?: number }).total_sessions ?? "-"}`
                : `행위자: ${e.actor}`,
      })),
      ...(paymentEvents ?? []).map((p) => ({
        id: `payment-${p.id}`,
        createdAt: p.created_at,
        kind: "PAYMENT" as const,
        label: paymentEventLabel(p.event_type),
        detail: `${p.amount.toLocaleString()} ${p.currency} / ${p.provider}`,
      })),
      ...(outboxMessages ?? []).map((o) => ({
        id: `outbox-${o.id}`,
        createdAt: o.created_at,
        kind: "OUTBOX" as const,
        label: `아웃박스: ${o.topic}`,
        detail: o.processed_at
          ? `처리 완료(${new Date(o.processed_at).toLocaleString("ko-KR")})`
          : `미처리(시도 ${o.attempts}회)${o.last_error ? ` — ${o.last_error}` : ""}`,
      })),
      ...(deadLetters ?? []).map((d) => ({
        id: `dlq-${d.id}`,
        createdAt: d.created_at,
        kind: "DLQ" as const,
        label: `DLQ: ${d.source}${d.resolved ? " (해결됨)" : " (미해결)"}`,
        detail: `${d.error_message}${d.resolution_reason ? ` — 처리 사유: ${d.resolution_reason}` : ""}`,
      })),
      ...(entitlements ?? []).map((e) => ({
        id: `entitlement-${e.id}`,
        createdAt: e.granted_at,
        kind: "ENTITLEMENT" as const,
        label: `이용권: ${e.access_code}`,
        detail: e.revoked_at ? `회수됨(${new Date(e.revoked_at).toLocaleString("ko-KR")})` : "유효",
      })),
      ...(auditLogs.data ?? []).map((a) => ({
        id: `audit-${a.id}`,
        createdAt: a.created_at,
        kind: "AUDIT" as const,
        label: `${a.action}${a.phase === "FAILED" ? " (실패)" : ""}`,
        detail: JSON.stringify(a.detail ?? {}),
      })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const hasDecidedNoRefund = (orderEvents ?? []).some((e) => e.event_type === "NO_REFUND_DECIDED");
    const canDecideNoRefund = isAdmin && order.status === "CANCELLED" && refundableAmount > 0 && !hasDecidedNoRefund;

    const discordWarning =
      isAdmin &&
      eligibilityCtx &&
      eligibilityCtx.requiresDiscord &&
      !eligibilityCtx.user.discordLinked
        ? "이 수강생은 디스코드를 연결하지 않았습니다 — 역할은 연결한 뒤에 부여됩니다(그 전에는 DLQ에 남음)."
        : null;

    return {
      kind: "ok",
      isAdmin,
      orderId: order.id,
      itemLabel,
      buyerEmail: (one(order.users) as { email: string } | undefined)?.email ?? "",
      statusCode: order.status,
      endLabel: isAdmin ? orderEndLabel(order.status, orderEventLikes)?.label ?? null : null,
      refundRequest: isAdmin ? refundRequestView : null,
      paymentStatusCode: order.payment_status,
      paymentStatusBadge,
      refundedText:
        order.payment_status === "PARTIALLY_REFUNDED" ? `(${order.refunded_amount.toLocaleString()}원 환불됨)` : null,
      amountText: `${order.final_amount?.toLocaleString() ?? "-"}원`,
      createdText: new Date(order.created_at).toLocaleString("ko-KR"),
      unreflectedSuccess: hasUnreflectedSuccess,
      eligibilityFailures:
        eligibility && !eligibility.eligible
          ? eligibility.failedRules.map((rule) => ({ code: rule.code, message: rule.message }))
          : null,
      canConfirmManually,
      canGrantAccess,
      discordWarning,
      canCloseWithoutRefund,
      canDecideNoRefund,
      // 환불 가능액이 0이어도 관리자에게는 항상 그린다 — 전액 PG 외 환불 직후 가능액이 0이 되면 패널과 그 안의 결과 팝업이 함께 사라지던 문제(U-4, 2026-10-02).
      // 빈 상태는 RefundPanel 안 early return이 처리한다.
      refund: isAdmin
        ? {
            originalPaymentMethod: order.payment_method,
            refundableAmount,
            requestKey: randomUUID(),
            formKey: randomUUID(),
            openRequest,
            isOrphanPayment,
            orphanKind,
            digitalConsumed,
            proposal: isAdmin ? refundProposalView() : null,
            requestSnapshot: refundSnapshotView,
            amountDefault: amountDefaultView,
          }
        : null,


      timeline: timeline.map((item) => ({
        id: item.id,
        kind: item.kind,
        kindLabel: KIND_LABELS[item.kind],
        label: item.label,
        detail: item.detail,
        timeText: new Date(item.createdAt).toLocaleString("ko-KR"),
      })),
      attempts: isAdmin
        ? attemptRows.map((a) => ({
            id: a.id,
            timeText: new Date(a.created_at).toLocaleString("ko-KR"),
            pgOrderId: a.pgOrderId ?? "-",
            provider: a.provider,
            confirmText: a.confirm_requested_at
              ? new Date(a.confirm_requested_at).toLocaleString("ko-KR")
              : "승인 요청 안 함 — 창 닫기·취소 등",
            resultText: !a.confirm_requested_at
              ? "-"
              : a.result
                ? `${paymentEventLabel(a.result.event_type)} (${new Date(a.result.created_at).toLocaleString("ko-KR")})`
                : "결과 없음 — PG 관리화면에서 확인 필요",
          }))
        : null,
    };
  });
}
