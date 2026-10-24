import { createAdminClient } from "@/lib/supabase/admin";
import { scheduleChangeState, type ScheduleChangeState } from "@/lib/shared/schedule-change";
import type { OrderEventLike } from "@/lib/shared/refund-request";

// 일정 변경 안내·응답의 서버 쪽 읽기 도우미. 주문·주문 이벤트·회차만 읽는다 — 모두 주문 모듈 소유라 R1 준수.
// 상태 판정은 순수 함수(lib/shared/schedule-change.ts)와 DB 함수가 같은 규칙을 쓴다.
export async function loadScheduleChangeState(orderId: string): Promise<{ status: string; paymentStatus: string; paymentMethod: string | null; state: ScheduleChangeState | null } | null> {
  const admin = createAdminClient();
  const [{ data: order, error: orderError }, { data: events, error }] = await Promise.all([
    admin.from("orders").select("status, payment_status, payment_method").eq("id", orderId).maybeSingle(),
    admin
      .from("order_events")
      .select("id, event_type, payload, created_at")
      .eq("order_id", orderId)
      .in("event_type", ["SCHEDULE_CHANGE_NOTICE", "SCHEDULE_CHANGE_ACCEPTED", "SCHEDULE_CHANGE_DECLINED"]),
  ]);
  if (orderError || error) throw new Error(`일정 변경 상태 조회 실패: ${(orderError ?? error)!.message}`);
  if (!order) return null;
  return {
    status: order.status,
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method,
    state: scheduleChangeState((events ?? []) as OrderEventLike[], order.status),
  };
}

/** 개설강의의 활성 회차(id 포함) — 관리자가 보낸 원하는 일정과 비교해 취소·추가를 계산하는 데 쓴다. */
export async function loadActiveSessions(offeringId: string): Promise<{ id: string; date: string; start: string; end: string }[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("course_sessions")
    .select("id, session_date, start_time, end_time")
    .eq("course_offering_id", offeringId)
    .is("deactivated_at", null)
    .order("session_date");
  if (error) throw new Error(`회차 조회 실패: ${error.message}`);
  return (data ?? []).map((s) => ({ id: s.id, date: s.session_date, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5) }));
}

/** 일정 변경 안내 메일 발송 사실 기록 — ORDER 소유 RPC 호출 대리 */
export async function markScheduleChangeNoticeEmailed(orderId: string, noticeEventId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc("record_schedule_change_email_sent", {
    p_order_id: orderId,
    p_notice_event_id: noticeEventId,
  });
  if (error) throw new Error(error.message);
}
