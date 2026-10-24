import { createClient } from "@/lib/supabase/server";
import { runQuery } from "@/lib/commands/run-command";
import { one } from "@/lib/supabase/relations";
import { CONDITIONAL_TERMS_TYPES, TERMS_TYPE_LABELS } from "@/lib/terms";
import { formatKst, toKstLocalInput } from "@/lib/shared/datetime";
import { formatSession } from "@/lib/shared/schedule-label";
import { formatProgress, sessionHasStarted, summarizeSessions } from "@/lib/shared/session-progress";
import { findOfferingCancelBlockers, ordersWithOpenRefundRequest } from "@/lib/guards/offering-cancel-settled";
import { offeringLifecycleLabel } from "@/lib/shared/offering-lifecycle";
import { fetchInChunks } from "@/lib/integrity/paging";
import { canExcludeForScheduleChange, isImminentScheduleChange, noticeAgeDays, scheduleChangeState, SCHEDULE_CHANGE_STATUS_LABELS, type ScheduleChangeStatus } from "@/lib/shared/schedule-change";
import { describeSnapshot, findOpenStudentRefundRequest, type OrderEventLike, type ProposalSnapshotSummary } from "@/lib/shared/refund-request";
import { formatOfferingEventTitle, formatOfferingEventDetail } from "@/lib/shared/offering-event";
import { loadRefundProposal } from "@/lib/orders/refund-proposal";
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from "./order-labels";

export type BulkRefundExecuteRow = {
  orderId: string;
  decidedAmount: number;
  rowReason: string;
  seenRefundable: number;
  seenProposalAmount: number;
};

export type BulkRefundExecutePayload = {
  batchId: string;
  refundCause: "STUDENT" | "OPERATOR";
  commonReason: string;
  rows: BulkRefundExecuteRow[];
};

export type BulkRefundItemResult = {
  orderId: string;
  email: string;
  outcome: "REQUESTED" | "SKIPPED" | "FAILED";
  amount: number;
  message?: string;
};

export type BulkRefundExecuteResult = {
  batchId: string;
  requestedCount: number;
  failedCount: number;
  skippedCount: number;
  totalRequestedAmount: number;
  items: BulkRefundItemResult[];
  summaryMessage: string;
};

export type {
  BulkRefundMode,
  BulkRefundPreviewResult,
  BulkRefundPreviewRow,
  BulkRefundPreviewSummary,
} from "@/lib/payment/bulk-refund-plan";

const OFFERING_STATUS_LABELS: Record<string, string> = {
  OPEN: "모집중",
  CLOSED: "마감",
  CANCELLING: "폐강중",
  CANCELLED: "폐강완료",
};

// 집계 카드 — 한 주문은 정확히 한 칸에 들어간다(결제 상태가 있으면 결제 상태 우선, 없으면 수강 상태).
const BUCKETS = [
  { key: "PENDING", label: "승인 대기" },
  { key: "APPROVED_UNPAID", label: "승인됨·미결제" },
  { key: "PAID", label: "결제 완료" },
  { key: "PARTIAL", label: "부분 환불" },
  { key: "REFUNDED", label: "환불 완료" },
  { key: "WAIVED", label: "무료(직권 부여)" },
  { key: "CLOSED", label: "취소·반려" },
] as const;
type BucketKey = (typeof BUCKETS)[number]["key"];

function bucketOf(order: { status: string; payment_status: string }): BucketKey {
  if (order.payment_status === "PAID") return "PAID";
  if (order.payment_status === "PARTIALLY_REFUNDED") return "PARTIAL";
  if (order.payment_status === "REFUNDED") return "REFUNDED";
  if (order.payment_status === "WAIVED") return "WAIVED";
  if (order.status === "PENDING") return "PENDING";
  if (order.status === "APPROVED") return "APPROVED_UNPAID";
  return "CLOSED";
}

const ORDER_LIST_LIMIT = 100;
// 집계용으로 한 번에 읽는 주문 수 상한(이 시스템은 강사 1인 규모 — 한 개설강의에 이 수를 넘는 신청은 가정하지 않는다).
const ORDER_SCAN_LIMIT = 5000;

type Grant = {
  type: string;
  discord_role_id?: string;
  discord_channel_id?: string;
  blob_pathname?: string;
  max_uses?: number;
};

function grantLabel(grant: Grant): string {
  if (grant.type === "COURSE_ACCESS") return "강의 접근";
  if (grant.type === "DISCORD_ROLE") {
    return `디스코드 역할 ${grant.discord_role_id ?? "-"}${
      grant.discord_channel_id ? ` · 채널 ${grant.discord_channel_id}` : ""
    }`;
  }
  if (grant.type === "SOURCE_DOWNLOAD") {
    return `소스 다운로드 ${grant.blob_pathname ?? "-"}${grant.max_uses ? ` (최대 ${grant.max_uses}회)` : ""}`;
  }
  return grant.type;
}

export type OfferingDetailView =
  | { kind: "notFound" }
  | {
      kind: "ok";
      offeringId: string;
      title: string;
      deleted: { text: string } | null; // "사유: … · 삭제자 · 시각"
      basic: {
        course: string;
        label: string;
        /** 모집·수명 표시(계산): 모집 전/모집중/마감/강의 중/종료 처리 대기/종료/폐강중/폐강완료 */
        statusText: string;
        statusReasonText: string | null; // "사유: … · 변경자 · 시각"
        /** 종료 기록: "종료 시각 · 처리자(관리자 이메일/자동) · 비고". 종료 전이면 null */
        endText: string | null;
        manualEndText: string;
        priceText: string;
        location: string;
        periodText: string;
        autoApproveText: string;
        autoRefundText: string;
        termsText: string;
        grants: string[];
        createdText: string;
        description: string | null;
        notice: string | null;
      };
      sessions: {
        id: string;
        text: string;
        active: boolean;
        deactivatedText: string | null;
        hasStarted: boolean;
        date: string;
        start: string;
        end: string;
      }[];
      /** 「총 N회 · 지난 M회 · 다음 11/17(화)」(활성 회차만, 지난 회차는 오늘 포함). 활성 회차가 없으면 빈 문자열. */
      sessionProgressText: string;
      /** 개설 후 회차 추가·취소. 조건은 DB 함수 assert_course_sessions_editable과 같다(서버가 다시 검사한다). */
      sessionEdit: { canEdit: boolean; lockText: string | null };
      /** 수강생이 있는 수업의 일정 변경 — 개강 후라도 미래 활성 회차가 있으면 가능. 응답 현황은 살아 있는 주문 중 안내를 받은 것만. */
      scheduleChange: {
        canChange: boolean;
        changeLockText: string | null;
        liveOrderCount: number;
        /** 현재 활성 회차(달력 미리 채움용). */
        currentSessions: { date: string; start: string; end: string }[];
        /** 이미 시작된 회차의 날짜 목록 (달력 잠금용). */
        lockedDates: string[];
        /** 변경 시점 기준 2시간 이내 임박 회차 포함 여부 경고 */
        isImminent: boolean;
        /** 같은 날짜에 활성 회차가 둘 이상이면 달력(날짜당 1회차)으로 바꿀 수 없다. */
        hasDuplicateDates: boolean;
        /** 현재 강의 장소 */
        currentLocation: string;
        responses: {
          orderId: string;
          href: string;
          email: string;
          paymentText: string;
          status: ScheduleChangeStatus;
          statusLabel: string;
          ageDays: number;
          /** NO_REFUND: 미결제·무료 → 환불 없이 제외. 결제 완료 건은 null (선별 일괄 환불로 처리). */
          excludeKind: "NO_REFUND" | null;
          suggestedRefundAmount: number | null;
          refundableAmount: number;
          noticeDate: string | null;
          emailedAt: string | null;
        }[];
      };
      seats: { text: string; mismatchText: string | null };
      orders: {
        buckets: { key: string; label: string; count: number }[];
        cancellingText: string | null;
        /** 수강생 처리 — 폐강 진행 중 학생별 처리 목록 및 일반 상태의 선별 환불. */
        processing: null | {
          isCancelling: boolean;
          rows: {
            id: string;
            email: string;
            name: string | null;
            statusText: string;
            paymentText: string;
            amountText: string;
            refundableText: string;
            /** 카드(PG) 결제라 일괄 환불 대상이 될 수 있는가. */
            canPgRefund: boolean;
            pgExclusionReason: string | null;
            openRefund: boolean;
            studentRefundRequestText: string | null;
            studentRefundProposalText: string | null;
            hasOpenStudentRequest: boolean;
            href: string;
          }[];
          blockers: { orderId: string; reason: string }[];
          /** 처리할 수강생이 0명이고 결제 쪽 미처리도 없을 때만 true. */
          canComplete: boolean;
          completeBlockedText: string | null;
        };
        totalText: string;
        rows: {
          id: string;
          email: string;
          name: string | null;
          statusText: string;
          paymentText: string;
          refundedText: string | null;
          amountText: string;
          createdText: string;
          href: string;
        }[];
      };
      /** 삭제된 개설강의는 null(작업 영역 없음). */
      work: null | {
        canEdit: boolean;
        edit: {
          label: string;
          location: string;
          recruitOpensAt: string;
          opensAt: string;
          endsAt: string;
          capacity: number;
          price: number;
          discordRoleId: string;
          discordChannelId: string;
          autoApprove: boolean;
          autoRefund: boolean;
          requiredTerms: string[];
          termOptions: { type: string; label: string }[];
          occupied: number;
          orderCount: number;
          paidCount: number;
          isFrozen: boolean;
          manualEnd: boolean;
        };
        /** 강의 종료: 종강일이 지난(또는 종강일 없이 개강한) 강의만 종료 가능, 종료된 강의만 종료 취소 가능. */
        end: { canEnd: boolean; canCancelEnd: boolean; openRefundRequestCount: number };
        status: string;
        toggle: { nextStatus: "OPEN" | "CLOSED"; label: "마감" | "재개"; placeholder: "마감 사유" | "재개 사유" } | null;
        courseName: string | null;
        labelRaw: string | null;
        canDelete: boolean;
      };
      history: {
        id: string;
        title: string;
        eventType: string;
        actorText: string;
        reason: string;
        detailText: string;
        createdText: string;
      }[];
    };

// 관리자 개설강의 상세(읽기 전용 + 기존 상태 액션) — U 단계 5. (2026-10-01): "어드민이 개설강의를 조회할 수 없다. 무슨 강의인지 세부내용을 볼 수 없다."
export async function loadAdminCourseOfferingDetail(offeringId: string): Promise<OfferingDetailView> {
  return runQuery({ command: "ADMIN_COURSE_OFFERING_DETAIL_VIEW" }, async () => {
    const supabase = await createClient();

    const { data: offering } = await supabase
      .from("course_offerings")
      .select(
        `id, label, capacity, remaining_seats, price, location, notice_text, auto_refund, recruit_opens_at, opens_at, ends_at, status,
       status_reason, status_changed_at, auto_approve, manual_end, ended_at, end_note, required_terms_types, grants, created_at,
       updated_at, deleted_at, deleted_reason,
       courses(name, description),
       status_changed_by_user:users!course_offerings_status_changed_by_fkey(email),
       deleted_by_user:users!course_offerings_deleted_by_fkey(email),
       ended_by_user:users!course_offerings_ended_by_fkey(email),
       course_sessions(id, session_date, start_time, end_time, deactivated_at, deactivated_reason)`,
      )
      .eq("id", offeringId)
      .maybeSingle();

    if (!offering) {
      return { kind: "notFound" };
    }

    const { data: orderRows, count: orderTotal } = await supabase
      .from("orders")
      .select("id, status, payment_status, payment_method, final_amount, refunded_amount, created_at, users(email, name)", {
        count: "exact",
      })
      .eq("course_offering_id", offeringId)
      .order("created_at", { ascending: false })
      .limit(ORDER_SCAN_LIMIT);
    const orders = orderRows ?? [];

    const counts = Object.fromEntries(BUCKETS.map((b) => [b.key, 0])) as Record<BucketKey, number>;
    for (const order of orders) counts[bucketOf(order)] += 1;

    // 좌석 — 점유(= 정원 − 잔여)는 좌석 예약·반환 함수가 관리한다. 살아 있는 신청(승인 대기·승인됨 — 취소·반려는 좌석을 돌려준다)과 다르면 정보용 진단 문구를 띄운다(수정 불가).
    const occupied = offering.capacity - offering.remaining_seats;
    const liveOrders = orders.filter((o) => o.status === "PENDING" || o.status === "APPROVED").length;
    const seatMismatch = occupied !== liveOrders;

    // 수강생 처리: 폐강 진행 중뿐만 아니라 일반 상태에서도 선별 환불을 지원한다.
    const isCancelling = offering.status === "CANCELLING";
    const remainingOrders = orders.filter((o) => o.status === "PENDING" || o.status === "APPROVED");
    const blockers = isCancelling ? await findOfferingCancelBlockers(offeringId) : [];
    const openRefundIds = remainingOrders.length > 0 ? await ordersWithOpenRefundRequest(remainingOrders.map((o) => o.id)) : new Set<string>();
    let dlqCount = 0;
    if (isCancelling && remainingOrders.length > 0) {
      const remainingIds = new Set(remainingOrders.map((o) => o.id));
      const { data: dlqs } = await supabase.from("dead_letters").select("id, payload").eq("resolved", false);
      for (const dlq of dlqs ?? []) {
        const orderId = (dlq.payload as { order_id?: string } | null)?.order_id;
        if (typeof orderId === "string" && remainingIds.has(orderId)) dlqCount += 1;
      }
    }

    const course = one(offering.courses);
    const sessions = [...(offering.course_sessions ?? [])].sort(
      (a, b) => a.session_date.localeCompare(b.session_date) || a.start_time.localeCompare(b.start_time),
    );
    const sessionEditState = (): { canEdit: boolean; lockText: string | null } => {
      if (offering.deleted_at) return { canEdit: false, lockText: "삭제된 개설강의의 일정은 바꿀 수 없습니다." };
      if (offering.status !== "OPEN" && offering.status !== "CLOSED") return { canEdit: false, lockText: "폐강된 개설강의의 일정은 바꿀 수 없습니다." };
      if (offering.ended_at) return { canEdit: false, lockText: "종료된 개설강의의 일정은 바꿀 수 없습니다." };
      if (new Date(offering.opens_at).getTime() <= Date.now()) return { canEdit: false, lockText: "개강한 수업의 일정은 바꿀 수 없습니다." };
      if (liveOrders > 0) {
        return { canEdit: false, lockText: "신청(승인 대기·승인됨)이 있는 수업은 개별 추가·취소가 아니라 아래 「일정 변경」(수강생 안내·동의)으로 바꿉니다." };
      }
      return { canEdit: true, lockText: null };
    };
    const activeLines = sessions
      .filter((s) => !s.deactivated_at)
      .map((s) => ({ date: s.session_date, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5) }));
    const lockedDates = sessions
      .filter((s) => !s.deactivated_at && sessionHasStarted(s.session_date, s.start_time))
      .map((s) => s.session_date);
    const unstartedActiveSessions = sessions.filter((s) => !s.deactivated_at && !sessionHasStarted(s.session_date, s.start_time));
    const isImminent = isImminentScheduleChange(
      unstartedActiveSessions.map((s) => ({ date: s.session_date, start: s.start_time })),
      [],
    );

    // 일정 변경: 살아 있는 신청자가 있어도 개강 여부와 무관하게 시작 전 활성 회차가 남아 있으면 가능하다.
    const changeLock = offering.deleted_at
      ? "삭제된 개설강의의 일정은 바꿀 수 없습니다."
      : offering.status !== "OPEN" && offering.status !== "CLOSED"
        ? "폐강된 개설강의의 일정은 바꿀 수 없습니다."
        : offering.ended_at
          ? "종료된 개설강의의 일정은 바꿀 수 없습니다."
          : unstartedActiveSessions.length === 0
            ? "시작 전인 남은 회차가 없어 일정을 바꿀 수 없습니다."
            : null;
    const liveOrderRows = orders.filter((o) => o.status === "PENDING" || o.status === "APPROVED");
    const scheduleEvents = await fetchInChunks<{ id: string; order_id: string; event_type: string; payload: unknown; created_at: string }>(
      liveOrderRows.map((o) => o.id),
      (chunk, from, to) =>
        supabase
          .from("order_events")
          .select("id, order_id, event_type, payload, created_at")
          .in("order_id", chunk)
          .in("event_type", [
            "SCHEDULE_CHANGE_NOTICE",
            "SCHEDULE_CHANGE_ACCEPTED",
            "SCHEDULE_CHANGE_DECLINED",
            "REFUND_REQUESTED",
            "REFUND_REQUEST_REJECTED",
            "SCHEDULE_CHANGE_NOTICE_EMAILED",
          ])
          .order("created_at")
          .range(from, to),
    );
    const eventsByOrder = new Map<string, OrderEventLike[]>();
    for (const e of scheduleEvents) {
      const list = eventsByOrder.get(e.order_id) ?? [];
      list.push({ id: e.id, event_type: e.event_type, payload: (e.payload ?? null) as Record<string, unknown> | null, created_at: e.created_at });
      eventsByOrder.set(e.order_id, list);
    }

    const scheduleResponses = await Promise.all(
      liveOrderRows.flatMap((o) => {
        const orderEvents = eventsByOrder.get(o.id) ?? [];
        const state = scheduleChangeState(orderEvents, o.status);
        if (!state) return [];
        const paid = o.payment_status === "PAID" || o.payment_status === "PARTIALLY_REFUNDED";
        const refundable = Math.max(0, (o.final_amount ?? 0) - (o.refunded_amount ?? 0));
        const noticeDate = state.noticedAt ? formatKst(state.noticedAt).slice(0, 10) : null;
        const emailSentEv = orderEvents.find(
          (e) =>
            e.event_type === "SCHEDULE_CHANGE_NOTICE_EMAILED" &&
            (e.payload?.notice_event_id === state.noticeId || String(e.payload?.notice_event_id) === state.noticeId),
        );
        const emailedAt = emailSentEv ? formatKst(emailSentEv.created_at) : null;
        return [
          (async () => {
            let suggestedAmount: number | null = null;
            if (paid && o.payment_method === "CARD" && refundable > 0) {
              try {
                const proposal = await loadRefundProposal(o.id, refundable, noticeDate ?? undefined);
                if (proposal?.eligible) {
                  suggestedAmount = proposal.amount;
                }
              } catch {
                suggestedAmount = null;
              }
            }
            return {
              orderId: o.id,
              href: `/admin/orders/${o.id}`,
              email: one(o.users)?.email ?? "",
              paymentText: PAYMENT_STATUS_LABELS[o.payment_status] ?? o.payment_status,
              status: state.status,
              statusLabel: SCHEDULE_CHANGE_STATUS_LABELS[state.status],
              ageDays: noticeAgeDays(state.noticedAt),
              excludeKind: paid ? null : ("NO_REFUND" as const),
              suggestedRefundAmount: suggestedAmount,
              refundableAmount: refundable,
              noticeDate,
              emailedAt,
            };
          })(),
        ];
      }),
    );
    const grants = (offering.grants ?? []) as Grant[];
    const requiredTerms = (offering.required_terms_types ?? []) as string[];
    const isDeleted = !!offering.deleted_at;
    const statusChangedBy = one(offering.status_changed_by_user)?.email;
    const canEdit = !isDeleted && (offering.status === "OPEN" || offering.status === "CLOSED");
    const discordGrant = grants.find((g) => g.type === "DISCORD_ROLE");
    const paidCount = counts.PAID + counts.PARTIAL;
    const deletedBy = one(offering.deleted_by_user)?.email;

    const { data: eventRows } = await supabase
      .from("course_offering_events")
      .select(
        `id, event_type, actor, actor_user_id, reason, before, after, created_at,
         actor_user:users!course_offering_events_actor_user_id_fkey(email)`,
      )
      .eq("course_offering_id", offeringId)
      .order("created_at", { ascending: false });

    const history = (eventRows ?? []).map((row) => {
      const actorUser = one(row.actor_user);
      const actorText = row.actor === "SYSTEM" ? "시스템" : (actorUser?.email ?? "관리자");
      return {
        id: row.id,
        title: formatOfferingEventTitle(row as any),
        eventType: row.event_type,
        actorText,
        reason: row.reason ?? "-",
        detailText: formatOfferingEventDetail(row as any),
        createdText: formatKst(row.created_at),
      };
    });

    return {
      kind: "ok",
      offeringId: offering.id,
      title: `${course?.name ?? ""}${offering.label ? ` (${offering.label})` : ""}`,
      deleted: isDeleted
        ? { text: `사유: ${offering.deleted_reason} · ${deletedBy ?? "-"} · ${formatKst(offering.deleted_at)}` }
        : null,
      basic: {
        course: course?.name ?? "",
        label: offering.label ?? "-",
        statusText: offeringLifecycleLabel(offering) || (OFFERING_STATUS_LABELS[offering.status] ?? offering.status),
        endText: offering.ended_at
          ? `${formatKst(offering.ended_at)} · ${one(offering.ended_by_user)?.email ?? "자동(기간 만료)"} · 비고: ${offering.end_note}`
          : null,
        manualEndText: offering.manual_end ? "켜짐(크론이 자동 종료하지 않음)" : "꺼짐(종강일이 지나면 자동 종료)",
        statusReasonText: offering.status_reason
          ? `사유: ${offering.status_reason} · ${statusChangedBy ?? "-"} · ${formatKst(offering.status_changed_at)}`
          : null,
        priceText: `${offering.price.toLocaleString()}원`,
        location: offering.location ?? "-",
        periodText: `모집 ${formatKst(offering.recruit_opens_at)} ~ 개강 ${formatKst(offering.opens_at)} 전 · 강좌 ${formatKst(offering.opens_at)} ~ ${offering.ends_at ? formatKst(offering.ends_at) : "종료일 없음"}`,
        autoApproveText: offering.auto_approve ? "켜짐" : "꺼짐",
        autoRefundText: offering.auto_refund ? "켜짐" : "꺼짐",
        termsText:
          requiredTerms.length > 0
            ? requiredTerms.map((t) => TERMS_TYPE_LABELS[t as keyof typeof TERMS_TYPE_LABELS] ?? t).join(", ")
            : "없음",
        grants: grants.map(grantLabel),
        createdText: `${formatKst(offering.created_at)} / ${formatKst(offering.updated_at)}`,
        description: course?.description || null,
        notice: offering.notice_text || null,
      },
      sessions: sessions.map((s) => ({
        id: s.id,
        text: formatSession(s),
        active: !s.deactivated_at,
        deactivatedText: s.deactivated_at ? `(비활성${s.deactivated_reason ? `: ${s.deactivated_reason}` : ""})` : null,
        hasStarted: sessionHasStarted(s.session_date, s.start_time),
        date: s.session_date,
        start: s.start_time.slice(0, 5),
        end: s.end_time.slice(0, 5),
      })),
      sessionProgressText: formatProgress(summarizeSessions(sessions)),
      sessionEdit: sessionEditState(),
      scheduleChange: {
        canChange: changeLock === null,
        changeLockText: changeLock,
        liveOrderCount: liveOrders,
        currentSessions: activeLines,
        lockedDates,
        isImminent,
        hasDuplicateDates: new Set(activeLines.map((l) => l.date)).size !== activeLines.length,
        currentLocation: offering.location ?? "",
        responses: scheduleResponses,
      },
      seats: {
        text: `정원 ${offering.capacity}명 · 잔여 ${offering.remaining_seats} · 점유 ${occupied}`,
        mismatchText: seatMismatch
          ? `좌석 점검 필요 — 점유 ${occupied}석과 살아 있는 신청(승인 대기·승인됨) ${liveOrders}건이 서로 다릅니다.`
          : null,
      },
      orders: {
        buckets: BUCKETS.map((b) => ({ key: b.key, label: b.label, count: counts[b.key] })),
        cancellingText: isCancelling
          ? `폐강 진행 중 — 처리할 수강생 ${remainingOrders.length}명 · 결제 쪽 미처리 ${blockers.length}건 · 미해결 DLQ ${dlqCount}건.`
          : null,
        processing: (isCancelling || remainingOrders.length > 0)
          ? {
              isCancelling,
              rows: remainingOrders.map((order) => {
                const user = one(order.users);
                const refundable = Math.max(0, (order.final_amount ?? 0) - (order.refunded_amount ?? 0));
                const paidLike = order.payment_status === "PAID" || order.payment_status === "PARTIALLY_REFUNDED";
                const openStudentReq = findOpenStudentRefundRequest(eventsByOrder.get(order.id) ?? [], order.status);
                const studentRefundRequestText = openStudentReq
                  ? `환불 신청 있음 (${formatKst(openStudentReq.created_at).slice(0, 10)}, 사유: ${String(openStudentReq.payload?.reason ?? "-")})`
                  : null;
                const studentRefundProposalText = openStudentReq?.payload?.proposal
                  ? `[신청 시점 제안: ${describeSnapshot(openStudentReq.payload.proposal as ProposalSnapshotSummary)}]`
                  : null;

                let canPgRefund = false;
                let pgExclusionReason: string | null = null;
                if (!paidLike) {
                  pgExclusionReason = "결제 없음(무료/직권 등)";
                } else if (order.payment_method !== "CARD") {
                  pgExclusionReason = "비카드(무통장 등 — 주문 상세에서 처리)";
                } else if (refundable <= 0) {
                  pgExclusionReason = "환불 가능 잔액 없음";
                } else {
                  canPgRefund = true;
                }

                return {
                  id: order.id,
                  email: user?.email ?? "-",
                  name: user?.name ?? null,
                  statusText: ORDER_STATUS_LABELS[order.status] ?? order.status,
                  paymentText: PAYMENT_STATUS_LABELS[order.payment_status] ?? order.payment_status,
                  amountText: `${order.final_amount?.toLocaleString() ?? "-"}원`,
                  refundableText: paidLike ? `${refundable.toLocaleString()}원` : "-",
                  canPgRefund,
                  pgExclusionReason,
                  openRefund: openRefundIds.has(order.id),
                  studentRefundRequestText,
                  studentRefundProposalText,
                  hasOpenStudentRequest: !!openStudentReq,
                  href: `/admin/orders/${order.id}`,
                };
              }),
              blockers,
              canComplete: isCancelling && remainingOrders.length === 0 && blockers.length === 0,
              completeBlockedText: isCancelling
                ? remainingOrders.length > 0
                  ? `처리할 수강생이 ${remainingOrders.length}명 남아 있습니다.`
                  : blockers.length > 0
                    ? `미처리 결제·이용권 건이 ${blockers.length}건 남아 있습니다.`
                    : null
                : null,
            }
          : null,
        totalText: `전체 ${orderTotal ?? orders.length}건${
        orders.length > ORDER_LIST_LIMIT ? ` 중 최근 ${ORDER_LIST_LIMIT}건` : ""
      }`,
        rows: orders.slice(0, ORDER_LIST_LIMIT).map((order) => {
          const user = one(order.users);
          return {
            id: order.id,
            email: user?.email ?? "-",
            name: user?.name ?? null,
            statusText: ORDER_STATUS_LABELS[order.status] ?? order.status,
            paymentText: PAYMENT_STATUS_LABELS[order.payment_status] ?? order.payment_status,
            refundedText:
              order.payment_status === "PARTIALLY_REFUNDED" ? `(${order.refunded_amount.toLocaleString()}원 환불됨)` : null,
            amountText: `${order.final_amount?.toLocaleString() ?? "-"}원`,
            createdText: formatKst(order.created_at),
            href: `/admin/orders/${order.id}`,
          };
        }),
      },
      work: isDeleted
        ? null
        : {
            canEdit,
            edit: {
              label: offering.label ?? "",
              location: offering.location ?? "",
              recruitOpensAt: toKstLocalInput(offering.recruit_opens_at),
              opensAt: toKstLocalInput(offering.opens_at),
              endsAt: toKstLocalInput(offering.ends_at),
              capacity: offering.capacity,
              price: offering.price,
              discordRoleId: discordGrant?.discord_role_id ?? "",
              discordChannelId: discordGrant?.discord_channel_id ?? "",
              autoApprove: offering.auto_approve,
              autoRefund: offering.auto_refund,
              requiredTerms,
              termOptions: CONDITIONAL_TERMS_TYPES.map((type) => ({ type, label: TERMS_TYPE_LABELS[type] ?? type })),
              occupied,
              orderCount: orderTotal ?? orders.length,
              paidCount,
              isFrozen: offering.status === "CLOSED" || new Date(offering.opens_at).getTime() <= Date.now(),
              manualEnd: offering.manual_end,
            },
            end: {
              canEnd:
                !offering.ended_at &&
                (offering.status === "OPEN" || offering.status === "CLOSED") &&
                new Date(offering.opens_at).getTime() <= Date.now() &&
                (!offering.ends_at || new Date(offering.ends_at).getTime() <= Date.now()),
              canCancelEnd: !!offering.ended_at && (offering.status === "OPEN" || offering.status === "CLOSED"),
              openRefundRequestCount: Array.from(eventsByOrder.values()).filter(
                (evts) => findOpenStudentRefundRequest(evts, "APPROVED") !== null,
              ).length,
            },
            status: offering.status,
            toggle:
              !offering.ended_at && (offering.status === "OPEN" || offering.status === "CLOSED")
                ? offering.status === "OPEN"
                  ? ({ nextStatus: "CLOSED", label: "마감", placeholder: "마감 사유" } as const)
                  : ({ nextStatus: "OPEN", label: "재개", placeholder: "재개 사유" } as const)
                : null,
            courseName: course?.name ?? null,
            labelRaw: offering.label,
            canDelete: offering.status !== "CANCELLING" && offering.status !== "CANCELLED",
          },
      history,
    };
  });
}
