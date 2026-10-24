import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/supabase/relations";
import { runQuery } from "@/lib/commands/run-command";
import { hasPermission } from "@/lib/auth/permissions";
import { fetchAllPages, fetchInChunks } from "@/lib/integrity/paging";
import { orderEndLabel } from "@/lib/shared/order-end-label";
import { findOpenStudentRefundRequest, requestAgeDays, requestAgeLevel, type OrderEventLike, type RequestAgeLevel } from "@/lib/shared/refund-request";

export type AdminOrderRowView = {
  id: string;
  /** 앞 8자 + "…" (링크 글자). */
  shortId: string;
  href: string;
  courseText: string;
  email: string;
  discordId: string;
  /** 수강상태·결제상태는 영문 코드 그대로(부록 A — e2e가 PENDING·APPROVED·PAID 등을 읽는다). */
  statusCode: string;
  paymentStatusCode: string;
  /** 부분환불일 때만 "(N원 환불됨)". */
  refundedText: string | null;
  canDecide: boolean; // 승인·반려 버튼(수강상태 PENDING)
  canCancel: boolean; // 취소 버튼(승인됨·미결제)
  /** 어떻게 끝났는지(「수강 포기(미수강)」 등). 해당 없으면 null. */
  endLabel: string | null;
  /** 수강생의 열린 환불 신청(ADMIN만 보인다 — 주문 이벤트는 RLS가 ADMIN에게만 연다). */
  refundRequest: { ageDays: number; level: RequestAgeLevel; text: string; isNotAllowedSection: boolean } | null;
  /** 개강 시각이 이미 지났는지 여부 (F-8: 개강 뒤 승인 시 경고 표시용). */
  isStarted?: boolean;
};

export type AdminOrdersView = {
  canApprove: boolean;
  rows: AdminOrderRowView[];
  /** 열린 환불 신청이 있는 주문(오래된 신청부터) — 목록 맨 위 안내용. */
  refundRequests: { id: string; href: string; shortId: string; courseText: string; email: string; ageDays: number; level: RequestAgeLevel; text: string; isNotAllowedSection: boolean }[];
};

// VIEW_STUDENTS 또는 APPROVE_ORDERS 권한이 있으면 들어올 수 있다(2026-09-18). 승인·반려·취소 버튼은 APPROVE_ORDERS일 때만 보인다.
// 학생 식별은 두 권한 모두 이메일로 한다.
export async function loadAdminOrders(): Promise<AdminOrdersView> {
  return runQuery({ command: "ADMIN_ORDERS_VIEW" }, async (profile) => {
    const canApprove = hasPermission(profile.permissions, "APPROVE_ORDERS");

    const supabase = await createClient();
    // discord_id는 2026-09-27부터 users가 아니라 discord_accounts(이용권 모듈)에서 온다.
    const { data: orders } = await supabase
      .from("orders")
      .select(
        "id, status, payment_status, refunded_amount, created_at, users(email, discord_accounts(discord_id)), course_offerings(label, opens_at, courses(name))",
      )
      .order("created_at", { ascending: false });

    // 환불 신청·거절과 「어떻게 끝났는지」 사건 — 주문 이벤트는 RLS가 ADMIN에게만 열려 있어 매니저는 읽지 않는다(조용히 빈 값이 오는 것을 피한다).
    // 환불 신청 사건은 전체에서 종류로 읽고(양이 적다), 종료 사건은 종료된 주문만 100개씩 묶어 읽는다(N+1 금지).
    const isAdmin = profile.role === "ADMIN";
    const eventsByOrder = new Map<string, OrderEventLike[]>();
    if (isAdmin) {
      const push = (e: { order_id: string; id: string; event_type: string; payload: unknown; created_at: string }) => {
        const list = eventsByOrder.get(e.order_id) ?? [];
        list.push({ id: e.id, event_type: e.event_type, payload: (e.payload ?? null) as Record<string, unknown> | null, created_at: e.created_at });
        eventsByOrder.set(e.order_id, list);
      };
      const requestEvents = await fetchAllPages<{ order_id: string; id: string; event_type: string; payload: unknown; created_at: string }>((from, to) =>
        supabase
          .from("order_events")
          .select("id, order_id, event_type, payload, created_at")
          .in("event_type", ["REFUND_REQUESTED", "REFUND_REQUEST_REJECTED"])
          .order("created_at")
          .range(from, to),
      );
      requestEvents.forEach(push);
      const endedIds = (orders ?? []).filter((o) => o.status === "CANCELLED").map((o) => o.id);
      const endEvents = await fetchInChunks<{ order_id: string; id: string; event_type: string; payload: unknown; created_at: string }>(endedIds, (chunk, from, to) =>
        supabase
          .from("order_events")
          .select("id, order_id, event_type, payload, created_at")
          .in("order_id", chunk)
          .in("event_type", ["CANCELLED", "CLOSED"])
          .order("created_at")
          .range(from, to),
      );
      endEvents.forEach(push);
    }
    const requestInfo = (orderId: string, status: string) => {
      const open = findOpenStudentRefundRequest(eventsByOrder.get(orderId) ?? [], status);
      if (!open) return null;
      const ageDays = requestAgeDays(open.created_at);
      const prop = open.payload?.proposal as { eligible?: boolean; stage?: string } | undefined;
      const isNotAllowedSection = prop?.eligible === false || prop?.stage === "NOT_ALLOWED";
      return {
        ageDays,
        level: requestAgeLevel(ageDays),
        text: ageDays === 0 ? "환불 신청 (오늘)" : `환불 신청 ${ageDays}일 경과`,
        isNotAllowedSection,
      };
    };

    const now = new Date();
    const rows = (orders ?? []).map((order) => {
      const opensAt = one(order.course_offerings)?.opens_at;
      const isStarted = !!opensAt && new Date(opensAt) <= now;
      return {
        id: order.id,
        shortId: `${order.id.slice(0, 8)}…`,
        href: `/admin/orders/${order.id}`,
        courseText: `${one(one(order.course_offerings)?.courses)?.name ?? ""}${
          one(order.course_offerings)?.label ? ` (${one(order.course_offerings)?.label})` : ""
        }`,
        email: one(order.users)?.email ?? "",
        discordId: one(one(order.users)?.discord_accounts)?.discord_id ?? "-",
        statusCode: order.status,
        paymentStatusCode: order.payment_status,
        refundedText:
          order.payment_status === "PARTIALLY_REFUNDED" ? `(${order.refunded_amount.toLocaleString()}원 환불됨)` : null,
        canDecide: order.status === "PENDING",
        canCancel: order.status === "APPROVED" && order.payment_status === "UNPAID",
        endLabel: orderEndLabel(order.status, eventsByOrder.get(order.id) ?? [])?.label ?? null,
        refundRequest: requestInfo(order.id, order.status),
        isStarted,
      };
    });

    const refundRequests = rows
      .filter((r) => r.refundRequest)
      .map((r) => ({ id: r.id, href: r.href, shortId: r.shortId, courseText: r.courseText, email: r.email, ...r.refundRequest! }))
      .sort((a, b) => b.ageDays - a.ageDays);

    return { canApprove, rows, refundRequests };
  });
}
