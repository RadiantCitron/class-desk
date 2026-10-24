import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { runOutboxBatch } from "@/lib/wiring/outbox";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다.");
}
const admin = createClient(url, key, { auth: { persistSession: false } });

async function ensureAdminUser(): Promise<string> {
  const { data: existing } = await admin.from("users").select("id").eq("role", "ADMIN").limit(1).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await admin
    .from("users")
    .insert({ auth_user_id: randomUUID(), email: `vitest-f7-admin-${randomUUID()}@example.com`, role: "ADMIN" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`관리자 생성 실패: ${error?.message}`);
  return data.id;
}

describe("설계된 예외 경로 — 통합", { timeout: 60_000 }, () => {
  let offeringIds: string[] = [];
  let courseId: string | null = null;

  afterEach(async () => {
    const actorId = await ensureAdminUser();
    for (const id of offeringIds) {
      await admin.rpc("delete_course_offering", { p_offering_id: id, p_reason: "vitest 정리", p_actor: actorId, p_actor_role: "ADMIN" });
    }
    offeringIds = [];
  });

  async function getCourse(): Promise<string> {
    if (courseId) return courseId;
    const { data, error } = await admin.from("courses").insert({ name: `vitest-f7-${randomUUID()}`, category: "TEST" }).select("id").single();
    if (error || !data) throw new Error(`강의 생성 실패: ${error?.message}`);
    courseId = data.id;
    return data.id;
  }

  it("correct_past_session: 시작 전 회차는 거부하고, 시작된 회차는 SESSION_CORRECTED 원장과 함께 정정된다", async () => {
    const adminId = await ensureAdminUser();
    const cid = await getCourse();

    // 1) 과거 회차가 포함된 개설강의 생성
    const y1 = 4000 + Math.floor(Math.random() * 500);
    const d1 = String(Math.floor(Math.random() * 20) + 1).padStart(2, "0");
    const { data: offId, error: createError } = await admin.rpc("create_course_offering", {
      p_course_id: cid,
      p_label: `F7-정정테스트-${randomUUID().slice(0, 6)}`,
      p_capacity: 10,
      p_price: 10000,
      p_location: null,
      p_required_terms_types: [],
      p_grants: [],
      p_recruit_opens_at: "2020-01-01T00:00:00Z",
      p_sessions: [
        { date: "2020-03-01", start: "10:00", end: "12:00" },
        { date: `${y1}-03-${d1}`, start: "10:00", end: "12:00" },
      ],
      p_actor: adminId,
      p_actor_role: "ADMIN",
    });
    expect(createError).toBeNull();
    offeringIds.push(offId);

    const { data: sessions } = await admin
      .from("course_sessions")
      .select("id, session_date, start_time, end_time")
      .eq("course_offering_id", offId)
      .order("session_date");
    expect(sessions).toHaveLength(2);
    const pastSession = sessions![0];
    const futureSession = sessions![1];

    // (a) 미래(시작 전) 회차 정정 시도 -> 거부
    const futureAttempt = await admin.rpc("correct_past_session", {
      p_session_id: futureSession.id,
      p_date: "2099-03-02",
      p_start: "10:00",
      p_end: "12:00",
      p_actor_id: adminId,
      p_actor_role: "ADMIN",
      p_reason: "미래 회차 정정 시도",
    });
    expect(futureAttempt.error?.message).toContain("아직 시작하지 않은 회차");

    // (b) 과거 회차를 미래 시각으로 정정 시도 -> 거부 (일정 변경이어야 함)
    const futureTargetAttempt = await admin.rpc("correct_past_session", {
      p_session_id: pastSession.id,
      p_date: "2099-03-02",
      p_start: "10:00",
      p_end: "12:00",
      p_actor_id: adminId,
      p_actor_role: "ADMIN",
      p_reason: "미래 시각으로 정정 시도",
    });
    expect(futureTargetAttempt.error?.message).toContain("이미 시작된 시각이어야");

    // (c) 정상 정정 (과거 회차의 시각 변경)
    const validCorrection = await admin.rpc("correct_past_session", {
      p_session_id: pastSession.id,
      p_date: "2020-03-01",
      p_start: "10:15",
      p_end: "12:15",
      p_actor_id: adminId,
      p_actor_role: "ADMIN",
      p_reason: "15분 지연 시작",
    });
    expect(validCorrection.error).toBeNull();

    // 기존 회차 비활성 확인
    const { data: oldSess } = await admin.from("course_sessions").select("deactivated_at, deactivated_reason").eq("id", pastSession.id).single();
    expect(oldSess?.deactivated_at).not.toBeNull();
    expect(oldSess?.deactivated_reason).toContain("15분 지연 시작");

    // 새 활성 회차 확인
    const { data: activeSessions } = await admin
      .from("course_sessions")
      .select("id, session_date, start_time, end_time")
      .eq("course_offering_id", offId)
      .is("deactivated_at", null)
      .order("session_date");
    expect(activeSessions).toHaveLength(2);
    expect(activeSessions![0].start_time).toBe("10:15:00");

    // course_offering_events에 SESSION_CORRECTED 기록 확인
    const { data: events } = await admin
      .from("course_offering_events")
      .select("event_type, actor, reason, before, after")
      .eq("course_offering_id", offId)
      .eq("event_type", "SESSION_CORRECTED");
    expect(events).toHaveLength(1);
    expect(events![0].reason).toBe("15분 지연 시작");
    expect((events![0].before as any).start_time).toBe("10:00:00");
    expect((events![0].after as any).start_time).toBe("10:15:00");
  });

  it("종결 주문 사후 환불: post_close 표지로 환불 시 REFUND_APPLIED 사건이 기록되고 DLQ로 가지 않는다", async () => {
    const adminId = await ensureAdminUser();
    const cid = await getCourse();

    const randYear = 3100 + Math.floor(Math.random() * 800);
    const randDay = String(Math.floor(Math.random() * 20) + 1).padStart(2, "0");
    const { data: offId, error: offErr } = await admin.rpc("create_course_offering", {
      p_course_id: cid,
      p_label: `F7-사후환불-${randomUUID().slice(0, 6)}`,
      p_capacity: 10,
      p_price: 30000,
      p_location: null,
      p_required_terms_types: [],
      p_grants: [],
      p_recruit_opens_at: "2020-01-01T00:00:00Z",
      p_sessions: [{ date: `${randYear}-05-${randDay}`, start: "14:00", end: "16:00" }],
      p_actor: adminId,
      p_actor_role: "ADMIN",
    });
    expect(offErr).toBeNull();
    offeringIds.push(offId);

    // 학생 유저 생성
    const { data: student } = await admin
      .from("users")
      .insert({ auth_user_id: randomUUID(), email: `vitest-f7-student-${randomUUID()}@example.com`, role: "STUDENT" })
      .select("id")
      .single();

    // 주문 생성 및 결제 완료 처리
    const orderId = randomUUID();
    const { error: ordErr } = await admin.from("orders").insert({
      id: orderId,
      user_id: student!.id,
      course_offering_id: offId,
      status: "APPROVED",
      payment_status: "UNPAID",
      list_price: 30000,
      final_amount: 30000,
      refunded_amount: 0,
      approved_at: new Date().toISOString(),
      paid_at: null,
      payment_method: null,
    });
    expect(ordErr).toBeNull();

    // 결제 성공 이벤트
    await admin.rpc("record_payment_event", {
      p_provider: "MOCK",
      p_provider_event_id: `evt-f7-paid-${randomUUID()}`,
      p_event_type: "PAYMENT_SUCCEEDED",
      p_amount: 30000,
      p_currency: "KRW",
      p_order_id: orderId,
      p_payment_method: "CARD",
      p_metadata: {},
      p_raw_payload: {},
      p_provider_transaction_id: "tid-f7-paid",
    });
    await runOutboxBatch();

    // 주문을 종결(CANCELLED) 상태로 전환 (사유: 관리자 직권 수강종료 등)
    await admin.from("orders").update({ status: "CANCELLED", cancelled_at: new Date().toISOString() }).eq("id", orderId);

    // 관리자가 post_close: true로 환불 개시
    const reqKey = `f7-post-req-${randomUUID()}`;
    const beginRes = await admin.rpc("begin_refund_request", {
      p_order_id: orderId,
      p_request_key: reqKey,
      p_amount: 30000,
      p_reason: "사후 번복 환불",
      p_source: "ADMIN",
      p_student_request_event_id: null,
      p_schedule_change_notice_event_id: null,
      p_post_close: true,
      p_actor_id: adminId,
    });
    expect(beginRes.error).toBeNull();

    // 환불 결제 이벤트 기록
    await admin.rpc("record_payment_event", {
      p_provider: "MOCK",
      p_provider_event_id: `evt-f7-ref-${randomUUID()}`,
      p_event_type: "REFUNDED",
      p_amount: 30000,
      p_currency: "KRW",
      p_order_id: orderId,
      p_payment_method: "CARD",
      p_metadata: {},
      p_raw_payload: {},
      p_provider_transaction_id: "tid-f7-paid",
    });

    // outbox 처리 (PAYMENT_REFUNDED -> on_payment_refunded)
    await runOutboxBatch();

    // 검증: 주문은 CANCELLED, payment_status=REFUNDED, refunded_amount=30000
    const { data: finalOrder } = await admin.from("orders").select("status, payment_status, refunded_amount").eq("id", orderId).single();
    expect(finalOrder).toMatchObject({
      status: "CANCELLED",
      payment_status: "REFUNDED",
      refunded_amount: 30000,
    });

    // order_events에 REFUND_APPLIED 사건 기록 검증
    const { data: refundEvents } = await admin
      .from("order_events")
      .select("event_type, payload")
      .eq("order_id", orderId)
      .eq("event_type", "REFUND_APPLIED");
    expect(refundEvents).toHaveLength(1);
    expect(refundEvents![0].payload).toMatchObject({
      cause: "POST_CLOSE_REFUND",
      reason: "사후 번복 환불",
      post_close: true,
      refund_amount: 30000,
    });

    // DLQ에 들어가지 않았는지 확인
    const { data: dlq } = await admin.from("dead_letters").select("id").eq("payload->>order_id", orderId);
    expect(dlq).toHaveLength(0);
  });
});
