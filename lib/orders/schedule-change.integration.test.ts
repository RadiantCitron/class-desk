import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { CURRENT_REFUND_POLICY_ID } from "@/lib/shared/refund-policy";
import { loadActiveSessions, loadScheduleChangeState } from "./schedule-change";

// 통합 테스트 — 로컬 Supabase 필요. : 일정 변경 안내·응답·미동의 제외(DB 함수 3개)와 서버 읽기 도우미.
// 개강이 아주 먼 미래인 수업을 만들어 쓰고, 끝에 주문을 취소·개설강의를 숨겨 정리한다.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다. .env.local을 확인하고 `npm run db:start` 뒤 다시 실행하세요.");
}
const admin = createClient(url, key, { auth: { persistSession: false } });

const minute = Math.floor(Math.random() * 1300) + 10;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

describe("일정 변경 안내·동의·미동의 제외 — 통합", { timeout: 90_000 }, () => {
  let userIds: string[] = [];
  let offeringId: string | null = null;
  let orderIds: string[] = [];

  afterEach(async () => {
    for (const id of orderIds) await admin.from("orders").update({ status: "CANCELLED", cancelled_at: new Date().toISOString() }).eq("id", id);
    if (offeringId && userIds[0]) {
      await admin.from("course_offerings").update({ deleted_at: new Date().toISOString(), deleted_reason: "vitest 정리", deleted_by: userIds[0] }).eq("id", offeringId);
      await admin.from("course_sessions").update({ deactivated_at: new Date().toISOString(), deactivated_reason: "vitest 정리" }).eq("course_offering_id", offeringId).is("deactivated_at", null);
    }
    for (const id of userIds) await admin.from("users").update({ withdrawn_at: new Date().toISOString() }).eq("id", id);
    userIds = [];
    orderIds = [];
    offeringId = null;
  });

  // ADMIN 회원 행은 앱에서 만들 수 없다(DB가 거부). 함수는 행위자 역할을 인자(p_actor_role)로 받으므로 행위자 id는 일반 회원 행이면 된다.
  async function newUser() {
    const { data, error } = await admin.from("users").insert({ auth_user_id: randomUUID(), email: `vitest-sc-${randomUUID()}@example.com`, role: "STUDENT" }).select("id").single();
    expect(error).toBeNull();
    userIds.push(data!.id);
    return data!.id as string;
  }

  async function setup(students: number, initialSessions?: { date: string; start: string; end: string }[]) {
    const adminId = await newUser();
    const { data: course } = await admin.from("courses").insert({ name: `vitest-sc-${randomUUID()}`, category: "TEST" }).select("id").single();
    const farYear = 6300 + Math.floor(Math.random() * 300);
    const defaultSessions = [
      { date: `${farYear}-03-03`, start: hhmm(minute), end: hhmm(minute + 1) },
      { date: `${farYear}-03-10`, start: hhmm(minute), end: hhmm(minute + 1) },
    ];
    const sessions = initialSessions ?? defaultSessions;

    const { data: id, error } = await admin.rpc("create_course_offering", {
      p_course_id: course!.id,
      p_label: "vitest-sc",
      p_capacity: 5,
      p_price: 10000,
      p_location: null,
      p_required_terms_types: [],
      p_grants: [{ type: "COURSE_ACCESS" }],
      p_recruit_opens_at: initialSessions ? "2019-01-01T00:00:00Z" : "2026-01-01T00:00:00Z",
      p_sessions: sessions,
      p_actor: adminId,
      p_actor_role: "ADMIN",
      p_auto_approve: false,
    });
    expect(error).toBeNull();
    offeringId = id as string;
    const orders: { userId: string; orderId: string }[] = [];
    for (let i = 0; i < students; i++) {
      const userId = await newUser();
      if (initialSessions) {
        // 개강 후인 개설강의는 create_order로 직접 신청할 수 없으므로(신청 기간 마감), 직권 부여(WAIVED)로 신청 건 삽입
        const { data: ord, error: ordErr } = await admin.from("orders").insert({
          user_id: userId,
          course_offering_id: offeringId,
          status: "APPROVED",
          approved_at: new Date().toISOString(),
          payment_status: "WAIVED",
          list_price: 10000,
          final_amount: 10000,
          refund_policy_version: CURRENT_REFUND_POLICY_ID,
        }).select("id").single();
        expect(ordErr).toBeNull();
        orderIds.push(ord!.id as string);
        orders.push({ userId, orderId: ord!.id as string });
      } else {
        const { data: orderId, error: orderError } = await admin.rpc("create_order", {
          p_user_id: userId,
          p_course_offering_id: offeringId,
          p_product_id: null,
          p_terms_ids: null,
          p_refund_policy_version: CURRENT_REFUND_POLICY_ID,
        });
        expect(orderError).toBeNull();
        orderIds.push(orderId as string);
        orders.push({ userId, orderId: orderId as string });
      }
    }
    return { adminId, farYear, orders };
  }

  it("일정 변경 → 살아 있는 주문마다 안내 → 안내 상태(NOTIFIED) → 미결제 수강생은 제외(좌석 반환)", async () => {
    const { adminId, farYear, orders } = await setup(2);
    const [orderA, orderB] = orders;
    const sessions = await loadActiveSessions(offeringId!);
    expect(sessions).toHaveLength(2);

    const { data: changed, error } = await admin.rpc("apply_schedule_change", {
      p_offering_id: offeringId,
      p_actor: adminId,
      p_actor_role: "ADMIN",
      p_reason: "강의장 사정",
      p_cancel_session_ids: [sessions[1].id],
      p_add_sessions: [{ date: `${farYear}-03-17`, start: hhmm(minute), end: hhmm(minute + 1) }],
    });
    expect(error).toBeNull();
    const result = changed as { change_id: string; notified: { order_id: string; user_id: string; notice_event_id: string }[] };
    expect(result.notified.map((n) => n.order_id).sort()).toEqual([orderA.orderId, orderB.orderId].sort());
    expect((await loadActiveSessions(offeringId!)).map((s) => s.date)).toEqual([`${farYear}-03-03`, `${farYear}-03-17`]);

    expect((await loadScheduleChangeState(orderA.orderId))?.state?.status).toBe("NOTIFIED");

    // 미결제 수강생 제외 처리(미결제 = 환불 없음, 좌석 반환)
    const { data: before } = await admin.from("course_offerings").select("capacity, remaining_seats").eq("id", offeringId!).single();
    const excluded = await admin.rpc("exclude_order_for_schedule_change", { p_order_id: orderB.orderId, p_actor_id: adminId, p_actor_role: "ADMIN", p_reason: "일정 변경으로 인한 제외" });
    expect(excluded.error).toBeNull();
    const { data: order } = await admin.from("orders").select("status").eq("id", orderB.orderId).single();
    expect(order?.status).toBe("CANCELLED");
    const { data: after } = await admin.from("course_offerings").select("remaining_seats").eq("id", offeringId!).single();
    expect(after!.remaining_seats).toBe(before!.remaining_seats + 1);
    const { data: closed } = await admin.from("order_events").select("payload").eq("order_id", orderB.orderId).eq("event_type", "CANCELLED").single();
    expect(closed?.payload).toMatchObject({ cause: "SCHEDULE_CHANGE" });
  });

  it("결과가 달라지지 않거나 활성 회차가 0이 되는 변경, 관리자가 아닌 호출은 거부된다", async () => {
    const { adminId, orders } = await setup(1);
    const sessions = await loadActiveSessions(offeringId!);
    const same = await admin.rpc("apply_schedule_change", { p_offering_id: offeringId, p_actor: adminId, p_actor_role: "ADMIN", p_reason: "x", p_cancel_session_ids: [], p_add_sessions: [] });
    expect(same.error).not.toBeNull();
    const none = await admin.rpc("apply_schedule_change", { p_offering_id: offeringId, p_actor: adminId, p_actor_role: "ADMIN", p_reason: "x", p_cancel_session_ids: sessions.map((s) => s.id), p_add_sessions: [] });
    expect(none.error).not.toBeNull();
    const notAdmin = await admin.rpc("apply_schedule_change", { p_offering_id: offeringId, p_actor: orders[0].userId, p_actor_role: "STUDENT", p_reason: "x", p_cancel_session_ids: [sessions[0].id], p_add_sessions: [] });
    expect(notAdmin.error).not.toBeNull();
    expect((await loadActiveSessions(offeringId!)).length).toBe(2);
  });

  it("F-4: 개강 후에도 시작 전 회차 변경은 허용되고, 이미 시작된 회차 취소는 차단된다", async () => {
    const { adminId } = await setup(1, [
      { date: "2020-01-01", start: "10:00", end: "12:00" }, // 이미 시작한(종료된) 과거 회차
      { date: "2098-03-03", start: "10:00", end: "12:00" }, // 미래 회차 1
      { date: "2098-03-10", start: "10:00", end: "12:00" }, // 미래 회차 2
    ]);
    const sessions = await loadActiveSessions(offeringId!);
    expect(sessions.length).toBe(3);

    // 1. 이미 시작된 회차(sessions[0], 2020-01-01) 취소 시도 -> 차단
    const tryCancelStarted = await admin.rpc("apply_schedule_change", {
      p_offering_id: offeringId,
      p_actor: adminId,
      p_actor_role: "ADMIN",
      p_reason: "시작된 회차 취소 시도",
      p_cancel_session_ids: [sessions[0].id],
      p_add_sessions: [],
    });
    expect(tryCancelStarted.error).not.toBeNull();
    expect(tryCancelStarted.error!.message).toContain("이미 시작한 회차");

    // 2. 시작 전 회차(sessions[1]) 취소 및 미래 새 회차 추가 -> 성공
    const okChange = await admin.rpc("apply_schedule_change", {
      p_offering_id: offeringId,
      p_actor: adminId,
      p_actor_role: "ADMIN",
      p_reason: "시작 전 회차 보강으로 변경",
      p_cancel_session_ids: [sessions[1].id],
      p_add_sessions: [{ date: "2099-01-01", start: "14:00", end: "16:00" }],
    });
    expect(okChange.error).toBeNull();

    // 안내 사건의 payload에 started 표기가 포함되는지 확인
    const { data: notices } = await admin
      .from("order_events")
      .select("id, order_id, payload")
      .eq("event_type", "SCHEDULE_CHANGE_NOTICE")
      .order("created_at", { ascending: false });
    expect(notices!.length).toBeGreaterThan(0);
    const payload = notices![0].payload as any;
    expect(payload.started).toBe(true);

    // A-8: record_schedule_change_email_sent RPC 동작 검증
    const { error: emailRecordErr } = await admin.rpc("record_schedule_change_email_sent", {
      p_order_id: notices![0].order_id,
      p_notice_event_id: notices![0].id,
    });
    expect(emailRecordErr).toBeNull();

    const { data: emailEvents } = await admin
      .from("order_events")
      .select("event_type, payload")
      .eq("order_id", notices![0].order_id)
      .eq("event_type", "SCHEDULE_CHANGE_NOTICE_EMAILED");
    expect(emailEvents).toHaveLength(1);
    expect((emailEvents![0].payload as any)?.notice_event_id).toBe(notices![0].id);
  });
});
