import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/supabase/relations";
import { runQuery } from "@/lib/commands/run-command";
import { checkRail } from "@/lib/commands/check";
import { offeringRequiresDiscord } from "@/lib/guards/discord-linked";
import { formatSessions } from "@/lib/shared/schedule-label";
import { offeringLifecycle, offeringLifecycleLabel } from "@/lib/shared/offering-lifecycle";
import { awaitsStaffProcessing, isCancellationSettled } from "./cancellation-banner";
import { canProposeRefund, evaluateRefund } from "@/lib/shared/refund-policy";
import { todayKst } from "@/lib/shared/session-progress";
import { orderEndLabel } from "@/lib/shared/order-end-label";
import { findLastRejection, findOpenStudentRefundRequest, studentProposalText, type OrderEventLike } from "@/lib/shared/refund-request";
import { describeChangedLines, describeLines, scheduleChangeState, type ScheduleChangeStatus } from "@/lib/shared/schedule-change";

// 폐강 진행·완료 개설강의 — 새 결제를 받을 수 없다(서버 결제 규칙 OFFERING_OPEN이 이미 막고, 여기서는 링크만 숨긴다).
function isOfferingWinddown(offeringStatus: string | undefined | null): boolean {
  return offeringStatus === "CANCELLING" || offeringStatus === "CANCELLED";
}

// 미결제 주문인데 결제할 수 없는 이유(없으면 null → 결제하기 링크를 보인다). 미결제가 아니면 "결제 내역" 링크라 null.
function paymentUnavailableReason(
  orderStatus: string,
  paymentStatus: string,
  offeringStatus: string | undefined | null,
): string | null {
  if (paymentStatus !== "UNPAID") return null;
  if (isOfferingWinddown(offeringStatus)) return "폐강";
  if (orderStatus === "REJECTED") return "반려";
  if (orderStatus === "CANCELLED") return "취소";
  return null;
}

// 취소·반려된 신청도 "신청 완료"로 뭉뚱그리지 않고 실제 상태를 보여준다. 단, [신청하기] 버튼을 다시 활성화하지는 않는다 —
// (학생, 개설강의) 유니크 제약이 상태와 무관하게 재신청을 막고 있어서(R3, 아직 결정 대기) 눌러도 "이미 신청한 내역입니다"로 실패한다.
const APPLIED_LABELS: Record<string, string> = {
  PENDING: "신청 완료",
  APPROVED: "신청 완료",
  REJECTED: "반려됨",
  CANCELLED: "취소됨",
};

// 상태값을 누구나 알 수 있는 한글로 보여준다. 학생 문구는 관리자 화면(ui/views/admin/order-labels.ts)과 의도적으로 다르다.
const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: "승인 대기 중",
  APPROVED: "승인됨",
  REJECTED: "반려됨",
  CANCELLED: "취소됨",
};
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  UNPAID: "미결제",
  PAID: "결제완료",
  PARTIALLY_REFUNDED: "부분환불",
  REFUNDED: "환불완료",
  WAIVED: "무료(직권 부여)",
};

export type EnrollmentRowView = {
  id: string;
  /** "과목명 (회차)" — 과목명이 없으면 빈 문자열부터 시작한다(원본과 같다). */
  courseText: string;
  notice: string | null;
  winddown: "progress" | "done" | null;
  /** 강의 수명 표시: 강의 중 / 종료 처리 대기 / 종료일 때만 값이 있다(그 밖의 단계는 신청 목록의 기존 표시로 충분). */
  lifecycleText: string | null;
  orderStatusText: string;
  paymentStatusText: string;
  /** 부분환불일 때만 "(N원 환불됨)". */
  refundedText: string | null;
  /** 결제할 수 없을 때 "결제 불가(폐강|반려|취소)". 있으면 payLink는 null. */
  unavailableText: string | null;
  payLink: { href: string; label: "결제하기" | "결제 내역" } | null;
  canCancel: boolean;
  showRefundHint: boolean;
  /**
   * 수강생 환불 신청 — 신청만 한다. AVAILABLE: 버튼(카드 결제·승인됨·약관 기준 가능한 구간), BLOCKED: 약관 기준으로 신청할 수 없는 구간(사유),
   * REQUESTED: 신청 후 관리자 검토 중. 무료·카드가 아닌 결제 등은 null(버튼 자체가 없다). 버튼이 켜져 있어도 서버가 다시 확인한다.
   */
  refund: { kind: "AVAILABLE"; proposalText: string; auto?: boolean } | { kind: "BLOCKED"; text: string } | { kind: "REQUESTED"; text: string } | null;
  /** 가장 최근 신청이 거절됐고 그 뒤 다시 신청하지 않았다면 거절 사유 문구. */
  refundRejectedText: string | null;
  /** 일정 변경 안내. 안내가 없으면 null. */
  scheduleChange: {
    noticeId: string;
    status: ScheduleChangeStatus;
    reason: string;
    beforeText: string;
    afterText: string;
    changedLines?: string;
  } | null;
};

export type OfferingRowView = {
  id: string;
  title: string;
  /** "50,000원 · 잔여 5자리 · 온라인(디스코드)" 형식 그대로. */
  meta: string;
  scheduleText: string | null;
  description: string | null;
  /** 이미 신청한 개설강의의 상태 문구("신청 완료"·"반려됨"·"취소됨"). 없으면 null → 버튼 링크를 보인다. */
  appliedLabel: string | null;
  canApply: boolean;
  /** canApply면 신청 페이지, 아니면 "#". */
  applyHref: string;
  /** canApply면 "신청하기", 아니면 막힌 이유 문구. */
  buttonText: string;
  /** 디스코드 강의인데 미연결인 경우 안내 문구 */
  discordNotice: string | null;
};

export type StudentHomeView =
  | { kind: "restricted"; message: string }
  | {
      kind: "ok";
      paidBanner: boolean;
      cancellationBanners: { offeringId: string; text: string }[];
      awaitingPayment: { id: string; courseText: string; href: string }[];
      discordId: string | null;
      hasDiscordOffering: boolean;
      enrollments: EnrollmentRowView[];
      offerings: OfferingRowView[];
    };

export async function loadStudentHome(input: { paid?: string }): Promise<StudentHomeView> {
  // proxy.ts가 이미 로그인/가입/탈퇴 여부를 확인했지만, 서버 컴포넌트 자체도 방어선을 하나 더 갖는다(runQuery가 레일 who로 다시 본다).
  // profile.id가 이 페이지에서 쓸 public.users.id다. 조회 통제(시스템·주문 모듈·이 화면·이 학생 대상 스위치, 옛 학생 VIEW 제한 포함)에
  // 걸리면 개설강의/내수강내역 조회 이전에 "제한됨" 화면 상태로 돌려보낸다.
  return runQuery<"STUDENT_HOME_VIEW", StudentHomeView>({ command: "STUDENT_HOME_VIEW", onDenied: (denial) => ({ kind: "restricted", message: denial.message }) }, async (profile) => {
    const supabase = await createClient();

    // 일정·설명을 추가로 조회한다(2026-09-26 수정) — 신청 화면이 이미 쓰는 것과 같은 컬럼·같은 표기 방식.
    const { data: offerings } = await supabase
      .from("course_offerings")
      .select(
        "id, label, price, capacity, remaining_seats, recruit_opens_at, opens_at, grants, courses(name, description), course_sessions(session_date, start_time, end_time, deactivated_at)",
      )
      .eq("status", "OPEN")
      // 종료된 강의는 신청 목록에서 숨긴다. 이미 신청한 사람의 「내 수강 내역」은 별도 조회라 그대로 보인다.
      .is("ended_at", null)
      .is("deleted_at", null);

    const { data: myEnrollments } = await supabase
      .from("orders")
      .select(
        "id, status, payment_status, payment_method, list_price, final_amount, refunded_amount, refund_policy_version, course_offering_id, created_at, course_offerings(label, status, notice_text, auto_refund, recruit_opens_at, opens_at, ends_at, ended_at, courses(name), course_sessions(session_date, start_time, end_time, deactivated_at))",
      )
      .eq("user_id", profile.id)
      .order("created_at", { ascending: false });

    // 환불 신청·거절과 주문이 어떻게 끝났는지(수강 포기 라벨)를 사건에서 읽는다 — 본인 주문의 사건만 RLS가 허용한다. 주문마다 따로 읽지 않고 한 번에.
    const myOrderIds = (myEnrollments ?? []).map((e) => e.id);
    const { data: myEvents } = myOrderIds.length
      ? await supabase
          .from("order_events")
          .select("id, order_id, event_type, payload, created_at")
          .in("order_id", myOrderIds)
          .in("event_type", ["REFUND_REQUESTED", "REFUND_REQUEST_REJECTED", "CANCELLED", "CLOSED", "SCHEDULE_CHANGE_NOTICE", "SCHEDULE_CHANGE_ACCEPTED", "SCHEDULE_CHANGE_DECLINED"])
      : { data: [] };
    const eventsByOrder = new Map<string, OrderEventLike[]>();
    for (const e of myEvents ?? []) {
      const list = eventsByOrder.get(e.order_id) ?? [];
      list.push({ id: e.id, event_type: e.event_type, payload: (e.payload ?? null) as Record<string, unknown> | null, created_at: e.created_at });
      eventsByOrder.set(e.order_id, list);
    }
    const today = todayKst();

    // F-8: 재신청 허용 — 신청 버튼 잠금 및 '신청 완료' 뱃지는 살아 있는 주문(PENDING, APPROVED) 기준이다.
    // 종결된(REJECTED, CANCELLED) 신청 건만 있는 개설강의는 다시 신청할 수 있다.
    const liveEnrollments = (myEnrollments ?? []).filter((e) => e.status === "PENDING" || e.status === "APPROVED");
    const appliedOfferingIds = new Set(liveEnrollments.map((e) => e.course_offering_id));
    const appliedStatusByOffering = new Map(liveEnrollments.map((e) => [e.course_offering_id, e.status]));

    // 승인됐는데 아직 결제 안 한 신청을 상단에 눈에 띄게 보여준다(이메일 없이 앱 내 배너로). 새 "읽음" 상태를 저장하지 않는다.
    const awaitingPaymentEnrollments = (myEnrollments ?? []).filter(
      (e) =>
        e.status === "APPROVED" &&
        e.payment_status === "UNPAID" &&
        !isOfferingWinddown(one(e.course_offerings)?.status),
    );

    // 폐강 배너 — 읽음 테이블 없음. 해당 개설의 본인 주문이 모두 CANCELLED|REJECTED로 정리되면(환불됨·환불 없이 종료·결제 전 정리 모두) 숨김(E-4, cancellation-banner.ts).
    type CancellationBanner = { offeringId: string; title: string; offeringStatus: string; refundPending: boolean };
    const cancellationBanners: CancellationBanner[] = [];
    {
      const byOffering = new Map<
        string,
        { title: string; offeringStatus: string; orders: { status: string; payment_status: string }[] }
      >();
      for (const e of myEnrollments ?? []) {
        const offering = one(e.course_offerings);
        const offeringStatus = offering?.status;
        if (offeringStatus !== "CANCELLING" && offeringStatus !== "CANCELLED") continue;
        const offeringId = e.course_offering_id as string;
        const courseName = one(offering?.courses)?.name ?? "강의";
        const label = offering?.label ? ` (${offering.label})` : "";
        const existing = byOffering.get(offeringId);
        if (existing) {
          existing.orders.push({ status: e.status, payment_status: e.payment_status });
        } else {
          byOffering.set(offeringId, {
            title: `${courseName}${label}`,
            offeringStatus,
            orders: [{ status: e.status, payment_status: e.payment_status }],
          });
        }
      }
      for (const [offeringId, info] of byOffering) {
        if (isCancellationSettled(info.orders)) continue;
        cancellationBanners.push({
          offeringId,
          title: info.title,
          offeringStatus: info.offeringStatus,
          refundPending: awaitsStaffProcessing(info.orders),
        });
      }
    }

    const enrollments: EnrollmentRowView[] = (myEnrollments ?? []).map((enrollment) => {
      const offering = one(enrollment.course_offerings);
      const unavailable = paymentUnavailableReason(enrollment.status, enrollment.payment_status, offering?.status);
      const events = eventsByOrder.get(enrollment.id) ?? [];
      const endLabel = orderEndLabel(enrollment.status, events);
      const openRequest = findOpenStudentRefundRequest(events, enrollment.status);
      const rejection = findLastRejection(events, enrollment.status);
      // 환불 신청 상태: 열린 신청 > (카드 결제 + 약관 기준 계산) > 없음. 계산이 실패해도(모르는 정책 버전 등) 화면을 깨지 않고 버튼을 숨긴다.
      let refund: EnrollmentRowView["refund"] = null;
      if (openRequest) {
        const when = typeof openRequest.payload?.requested_on === "string" ? `${openRequest.payload.requested_on} 신청 · ` : "";
        refund = { kind: "REQUESTED", text: `환불 신청됨 — ${when}관리자가 검토 중입니다` };
      } else if (canProposeRefund(enrollment) && enrollment.payment_method === "CARD" && enrollment.final_amount !== null) {
        try {
          const proposal = evaluateRefund({
            paid: enrollment.final_amount,
            refundable: enrollment.final_amount - enrollment.refunded_amount,
            listPrice: enrollment.list_price,
            sessions: offering?.course_sessions ?? [],
            today,
            policyId: enrollment.refund_policy_version,
          });
          const isAutoRefund =
            offering?.auto_refund === true &&
            proposal.eligible &&
            proposal.amount > 0 &&
            enrollment.status === "APPROVED" &&
            offering?.status !== "CANCELLING" &&
            offering?.status !== "CANCELLED";
          const baseProposalText = studentProposalText(proposal);
          const proposalText =
            offering?.status === "CANCELLING"
              ? `폐강 처리 중입니다 — 신청은 접수되며 관리자가 수강생별로 환불을 처리합니다. (${baseProposalText})`
              : baseProposalText;
          refund = { kind: "AVAILABLE", proposalText, auto: isAutoRefund };
        } catch {
          refund = null;
        }
      }
      const change = scheduleChangeState(events, enrollment.status);
      const rejectedReason = typeof rejection?.payload?.reason === "string" ? rejection.payload.reason : null;
      return {
        id: enrollment.id,
        courseText: `${one(offering?.courses)?.name ?? ""}${offering?.label ? ` (${offering.label})` : ""}`,
        notice: offering?.notice_text || null,
        winddown: offering?.status === "CANCELLING" ? "progress" : offering?.status === "CANCELLED" ? "done" : null,
        lifecycleText:
          offering && ["IN_PROGRESS", "END_PENDING", "ENDED"].includes(offeringLifecycle(offering))
            ? offeringLifecycleLabel(offering)
            : null,
        // 환불·폐강 등으로 끝난 신청은 「취소됨」 대신 어떻게 끝났는지(「수강 포기(미수강)」 등)를 보인다(ADR-0026).
        orderStatusText: endLabel?.label ?? ORDER_STATUS_LABELS[enrollment.status] ?? enrollment.status,
        paymentStatusText: PAYMENT_STATUS_LABELS[enrollment.payment_status] ?? enrollment.payment_status,
        refundedText:
          enrollment.payment_status === "PARTIALLY_REFUNDED"
            ? `(${enrollment.refunded_amount.toLocaleString()}원 환불됨)`
            : null,
        unavailableText: unavailable ? `결제 불가(${unavailable})` : null,
        // 무료(직권 부여)는 결제할 일도 볼 결제 내역도 없다 — 링크를 숨긴다.
        payLink: unavailable || enrollment.payment_status === "WAIVED"
          ? null
          : {
              href: `/student/payment/${enrollment.id}`,
              label: enrollment.payment_status === "UNPAID" ? "결제하기" : "결제 내역",
            },
        canCancel:
          enrollment.payment_status === "UNPAID" && ["PENDING", "APPROVED"].includes(enrollment.status),
        showRefundHint:
          refund === null && (enrollment.payment_status === "PAID" || enrollment.payment_status === "PARTIALLY_REFUNDED"),
        refund,
        refundRejectedText: rejectedReason ? `환불 신청이 거절되었습니다 — 사유: ${rejectedReason}` : null,
        scheduleChange: change
          ? {
              noticeId: change.noticeId,
              status: change.status,
              reason: change.reason,
              beforeText: describeLines(change.before),
              afterText: describeLines(change.after),
              changedLines: describeChangedLines(change.before, change.after),
            }
          : null,
      };
    });

    // 수강 신청 통제(명령 레일) — 이 학생 대상 신청 제한뿐 아니라 시스템·주문 모듈·신청 명령 봉쇄도 같은 판정으로 본다.
    // 버튼은 이 판정으로 숨기고, 실제 차단은 applyForOffering(runCommand)이 같은 판정으로 다시 한다(2중 방어).
    const applyRail = await checkRail("ORDER_APPLY", profile);

    const offeringRows: OfferingRowView[] = (offerings ?? []).map((offering) => {
      const remaining = offering.remaining_seats;
      const alreadyApplied = appliedOfferingIds.has(offering.id);
      const now = new Date();
      // 신청 기간 = 모집 시작 ≤ 지금 < 개강. 개강하면 모집 마감이다.
      const notYetOpen = new Date(offering.recruit_opens_at) > now;
      const alreadyEnded = new Date(offering.opens_at) <= now;
      const applyRestricted = !applyRail.ok;
      // F-5: 온라인(디스코드) 수업이어도 미연결 학생의 신청을 막지 않는다(신청은 허용, 결제만 금지).
      const requiresDiscord = offeringRequiresDiscord(offering.grants);
      const discordMissing = requiresDiscord && !profile.discordId;
      // 모집기간(recruit_opens_at~opens_at 전) 강제: create_order()도 동일 조건을 DB에서 다시 확인하므로(2중 방어) 여기서는 UX용 1차 체크다.
      const canApply =
        remaining > 0 && !alreadyApplied && !notYetOpen && !alreadyEnded && !applyRestricted;

      // 계정 제한 사유를 최우선으로 보여준다 — 관리자가 왜 막았는지가 학생에게 가장 필요한 정보다(이유와 함께 안내 원칙).
      let disabledReason = "";
      if (!applyRail.ok) disabledReason = `신청 불가: ${applyRail.message}`;
      else if (notYetOpen) disabledReason = "모집 전";
      else if (alreadyEnded) disabledReason = "모집 마감(개강)";
      else if (remaining <= 0) disabledReason = "정원 마감";

      return {
        id: offering.id,
        title: `${one(offering.courses)?.name ?? ""}${offering.label ? ` (${offering.label})` : ""}`,
        meta: `${offering.price.toLocaleString()}원 · 잔여 ${Math.max(remaining, 0)}자리${requiresDiscord ? " · 온라인(디스코드)" : ""}`,
        scheduleText: formatSessions(offering.course_sessions ?? []) || null,
        description: one(offering.courses)?.description || null,
        appliedLabel: alreadyApplied
          ? (APPLIED_LABELS[appliedStatusByOffering.get(offering.id) ?? ""] ?? "신청 완료")
          : null,
        canApply,
        applyHref: canApply ? `/student/apply/${offering.id}` : "#",
        buttonText: canApply ? "신청하기" : disabledReason,
        discordNotice:
          discordMissing && canApply
            ? "디스코드로 진행하는 강의입니다 — 결제 전에 디스코드 연결이 필요합니다"
            : null,
      };
    });

    return {
      kind: "ok",
      paidBanner: input.paid === "1",
      cancellationBanners: cancellationBanners.map((b) => ({
        offeringId: b.offeringId,
        text: `${b.title}${b.offeringStatus === "CANCELLING" ? " — 폐강 진행 중" : " — 폐강 완료"}${
        b.refundPending
          ? " · 결제하셨거나 수강권을 받으신 건은 담당자가 환불·정리를 개별로 처리하고 안내해 드립니다. 내 수강 내역에서 상태를 확인해 주세요."
          : " · 신청·결제 상태는 내 수강 내역에서 확인해 주세요."
      } 중요 안내는 등록 이메일로도 보내 드립니다(수신함·스팸함 확인).`,
      })),
      awaitingPayment: awaitingPaymentEnrollments.map((e) => ({
        id: e.id,
        courseText: `${one(one(e.course_offerings)?.courses)?.name ?? ""}${
        one(e.course_offerings)?.label ? ` (${one(e.course_offerings)?.label})` : ""
      }`,
        href: `/student/payment/${e.id}`,
      })),
      discordId: profile.discordId,
      hasDiscordOffering: (offerings ?? []).some((offering) => offeringRequiresDiscord(offering.grants)),
      enrollments,
      offerings: offeringRows,
    };
  });
}
