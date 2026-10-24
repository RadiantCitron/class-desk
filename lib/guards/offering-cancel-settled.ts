import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllPages, fetchInChunks } from "@/lib/integrity/paging";
import { findOpenRefundRequest } from "@/lib/payment/ledger-view";

// 폐강 중 학생 처리(ADR-0021)의 결제 원장 쪽 판정 — 읽기 전용 CS 가드.
// 주문 모듈 DB 함수(complete_course_offering_cancel, close_order_without_refund)는 결제 원장을 읽을 수 없다(R1) —
// 그래서 「처리가 끝났는가」 중 원장이 알아야 하는 부분(열린 환불 요청, 고아 결제)은 여기서 서버 액션이 확인한다.
// CS 가드는 여러 모듈을 읽어도 되는 유일한 자리다(CS_READ_ONLY_EXCEPTIONS). 조회 실패는 「문제 없음」으로 보지 않고 던진다(fail-closed).

export type SettleBlocker = { orderId: string; reason: string };

type LedgerRow = { id: string; order_id: string; event_type: string; amount: number | null; created_at: string };

async function loadLedger(orderIds: string[]): Promise<Map<string, LedgerRow[]>> {
  const admin = createAdminClient();
  const rows = await fetchInChunks<LedgerRow>(orderIds, (chunk, from, to) =>
    admin
      .from("payment_events")
      .select("id, order_id, event_type, amount, created_at")
      .in("order_id", chunk)
      .in("event_type", ["PAYMENT_SUCCEEDED", "REFUND_REQUESTED", "REFUNDED", "REFUND_REQUEST_FAILED"])
      .order("id")
      .range(from, to),
  );
  const byOrder = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const list = byOrder.get(row.order_id) ?? [];
    list.push(row);
    byOrder.set(row.order_id, list);
  }
  return byOrder;
}

/** 이 주문들 중 아직 닫히지 않은 환불 요청이 있는 주문 id. 「환불 없이 종료」가 진행 중인 환불을 건너뛰지 않게 한다. */
export async function ordersWithOpenRefundRequest(orderIds: string[]): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const ledger = await loadLedger(orderIds);
  const open = new Set<string>();
  for (const [orderId, rows] of ledger) {
    if (findOpenRefundRequest(rows) !== null) open.add(orderId);
  }
  return open;
}

/**
 * 폐강 완료를 막는 원장·이용권·주문 사건 쪽 사유. 수강 상태(승인 대기·승인됨이 남음)는 DB 함수가 따로 막는다.
 *  · 열린 환불 요청: 환불이 PG에서 진행 중 — 끝나야 주문이 정리된다.
 *  · 고아 결제: 결제 진행 중 폐강·취소로 주문은 미결제인데 원장에는 돈이 남은 건(대사 ②와 같은 기준 — 성공 합 − 환불 합 > 0).
 *  · (가) 회수 대기 이용권: 끝난 주문(CANCELLED)에 아직 회수되지 않은(revoked_at is null) 이용권이 있음.
 *  · (나) 받은 돈이 남았는데 처리 결정이 없는 끝난 주문: CANCELLED이고 원장 잔액 > 0인데,
 *        취소 사건에 원인(payload.cause)이 없고 CLOSED / NO_REFUND_DECIDED 결정 사건도 없음.
 *        단, 관리자가 이번 폐강 완료 호출에서 확인(acknowledgedOrderIds)한 주문은 건너뛴다.
 */
export async function findOfferingCancelBlockers(
  offeringId: string,
  acknowledgedOrderIds?: Set<string>,
): Promise<SettleBlocker[]> {
  const admin = createAdminClient();
  const orders = await fetchAllPages<{ id: string; status: string; payment_status: string }>((from, to) =>
    admin
      .from("orders")
      .select("id, status, payment_status")
      .eq("course_offering_id", offeringId)
      .order("id")
      .range(from, to),
  );
  if (orders.length === 0) return [];

  const orderIds = orders.map((o) => o.id);
  const ledger = await loadLedger(orderIds);

  // (가) 검사용: 끝난 주문의 이용권 조회
  const cancelledOrderIds = orders.filter((o) => o.status === "CANCELLED").map((o) => o.id);
  const unrevokedEntitlementsByOrder = new Set<string>();
  if (cancelledOrderIds.length > 0) {
    const entRows = await fetchInChunks<{ order_id: string }>(cancelledOrderIds, (chunk, from, to) =>
      admin
        .from("entitlements")
        .select("order_id")
        .in("order_id", chunk)
        .is("revoked_at", null)
        .range(from, to),
    );
    for (const r of entRows) {
      if (r.order_id) unrevokedEntitlementsByOrder.add(r.order_id);
    }
  }

  // (나) 검사용: 끝난 주문의 사건 조회 (CANCELLED, CLOSED, NO_REFUND_DECIDED)
  type OrderEventLite = { order_id: string; event_type: string; payload: Record<string, unknown> | null };
  const eventsByOrder = new Map<string, OrderEventLite[]>();
  if (cancelledOrderIds.length > 0) {
    const eventRows = await fetchInChunks<OrderEventLite>(cancelledOrderIds, (chunk, from, to) =>
      admin
        .from("order_events")
        .select("order_id, event_type, payload")
        .in("order_id", chunk)
        .in("event_type", ["CANCELLED", "CLOSED", "NO_REFUND_DECIDED"])
        .range(from, to),
    );
    for (const er of eventRows) {
      const list = eventsByOrder.get(er.order_id) ?? [];
      list.push(er);
      eventsByOrder.set(er.order_id, list);
    }
  }

  const blockers: SettleBlocker[] = [];
  for (const order of orders) {
    const rows = ledger.get(order.id) ?? [];
    if (findOpenRefundRequest(rows) !== null) {
      blockers.push({ orderId: order.id, reason: "환불 요청이 아직 진행 중입니다." });
      continue;
    }
    const paid = rows.filter((r) => r.event_type === "PAYMENT_SUCCEEDED").reduce((s, r) => s + (r.amount ?? 0), 0);
    const refunded = rows.filter((r) => r.event_type === "REFUNDED").reduce((s, r) => s + (r.amount ?? 0), 0);
    const netPaid = paid - refunded;

    if (order.payment_status === "UNPAID" && order.status !== "PENDING") {
      if (netPaid > 0) {
        blockers.push({
          orderId: order.id,
          reason: `고아 결제 — 결제는 성공했는데 주문은 미결제(${order.status})입니다. 미환불 ${netPaid.toLocaleString()}원.`,
        });
      }
    }

    if (order.status === "CANCELLED") {
      // (가) 회수 대기 이용권
      if (unrevokedEntitlementsByOrder.has(order.id)) {
        blockers.push({
          orderId: order.id,
          reason: "이용권·디스코드 역할 회수가 아직 끝나지 않았습니다(아웃박스 처리 대기 또는 실패) — 잠시 뒤 다시 시도하거나 실패함(DLQ)을 확인하세요.",
        });
        continue;
      }

      // (나) 받은 돈이 남았는데 처리 결정이 없는 끝난 주문
      if (netPaid > 0) {
        if (acknowledgedOrderIds?.has(order.id)) {
          // 관리자가 이번 완료 단계에서 확인 및 사유를 남기기로 지정함
          continue;
        }

        const evts = eventsByOrder.get(order.id) ?? [];
        const hasClosed = evts.some((e) => e.event_type === "CLOSED");
        const hasNoRefund = evts.some((e) => e.event_type === "NO_REFUND_DECIDED");
        const cancelEvt = evts.find((e) => e.event_type === "CANCELLED");
        const hasCause = Boolean(cancelEvt?.payload && cancelEvt.payload.cause);

        if (!hasClosed && !hasNoRefund && !hasCause) {
          blockers.push({
            orderId: order.id,
            reason: `탈퇴 등으로 종료되었으나 미환불금 ${netPaid.toLocaleString()}원이 남아 있습니다. 환불하거나 「환불하지 않고 마무리」를 확인해야 합니다.`,
          });
        }
      }
    }
  }
  return blockers;
}
