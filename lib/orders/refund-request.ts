import { createAdminClient } from "@/lib/supabase/admin";
import { findOpenStudentRefundRequest, type OrderEventLike } from "@/lib/shared/refund-request";

// 수강생 환불 신청의 서버 쪽 읽기 도우미. 주문 이벤트(order_events)만 읽는다 — 주문 모듈 소유라 R1 준수.
// 「열린 신청」 판정은 순수 함수(lib/shared/refund-request.ts)와 DB 함수가 같은 규칙을 쓴다.
export async function loadOpenRefundRequest(orderId: string): Promise<OrderEventLike | null> {
  const admin = createAdminClient();
  const [{ data: order, error: orderError }, { data: events, error }] = await Promise.all([
    admin.from("orders").select("status").eq("id", orderId).maybeSingle(),
    admin
      .from("order_events")
      .select("id, event_type, payload, created_at")
      .eq("order_id", orderId)
      .in("event_type", ["REFUND_REQUESTED", "REFUND_REQUEST_REJECTED"]),
  ]);
  if (orderError || error) throw new Error(`환불 신청 조회 실패: ${(orderError ?? error)!.message}`);
  if (!order) return null;
  return findOpenStudentRefundRequest((events ?? []) as OrderEventLike[], order.status);
}
