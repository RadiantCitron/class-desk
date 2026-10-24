import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { confirmPayment, requestRefund } from "@/lib/payment";
import { findOfferingCancelBlockers, ordersWithOpenRefundRequest } from "@/lib/guards/offering-cancel-settled";
import { tossProvider } from "@/lib/payment/providers/toss";
import {
  fakePgEnvOverrides,
  getFakePgOrigin,
  setTossCancelBehavior,
  startFakePg,
  stopFakePg,
} from "@/lib/payment/providers/fake-pg-harness";
import { runOutboxBatch } from "@/lib/wiring/outbox";

/**
 * 폐강은 환불을 자동 개시하지 않는다. 결제·무료(직권 부여) 수강생은 관리자가 학생별로 처리한다
 * (전액 환불 / 환불 없이 종료)하고, 모두 처리되어야 폐강이 완료된다. (이전: D 폐강 일괄 자동 환불 — 대체됨.)
 * `npm run test:integration` / 직접 vitest run. [로컬] 전용(가짜 PG).
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요");
}
const admin = createClient(url, key, { auth: { persistSession: false } });

const ENV_KEYS = [
  "TOSS_SECRET_KEY",
  "NEXT_PUBLIC_TOSS_CLIENT_KEY",
  "TOSS_API_BASE_URL",
  "NEXT_PUBLIC_TOSS_SDK_URL",
  "PG_CANCEL_TIMEOUT_MS",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

// 드레인(대사 포함)을 여러 번 돌려 잔여 행이 쌓일수록 느려진다 — 이 파일만 60초.
describe("폐강 학생별 처리 — 통합", { timeout: 60_000 }, () => {
  const cleanupUserIds: string[] = [];
  const cleanupAuthIds: string[] = [];
  let courseId: string | null = null;
  let offeringId: string | null = null;
  let actorId: string | null = null;

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    await startFakePg();
    Object.assign(process.env, fakePgEnvOverrides());

    const email = `vitest-coded-admin-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(authError?.message);
    cleanupAuthIds.push(authUser.user.id);
    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({ auth_user_id: authUser.user.id, email, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(profileError?.message);
    // RPC actor는 uuid만 필요(역할 검사 없음). ADMIN INSERT는 앱에서 금지.
    actorId = profile.id;
    cleanupUserIds.push(profile.id);

    const { data: course, error: courseError } = await admin
      .from("courses")
      .insert({ name: `vitest-coded-${randomUUID()}` })
      .select("id")
      .single();
    if (courseError || !course) throw new Error(courseError?.message);
    courseId = course.id;
  });

  afterAll(async () => {
    stopFakePg();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (courseId) await admin.from("courses").delete().eq("id", courseId);
    for (const id of cleanupUserIds) {
      await admin.from("users").update({ withdrawn_at: new Date().toISOString() }).eq("id", id);
    }
    for (const id of cleanupAuthIds) {
      await admin.auth.admin.deleteUser(id);
    }
  });

  afterEach(async () => {
    // 결제 원장·주문·개설강의는 지우지 않고 db:reset이 정리한다.
    // 각 테스트는 독립된 개설강의를 생성하므로 상태 잔여가 없다.
  });

  async function ensureOffering(capacity = 10, price = 50000): Promise<string> {
    const { data: offering, error } = await admin
      .from("course_offerings")
      .insert({
        course_id: courseId!,
        label: "Code-D",
        capacity,
        remaining_seats: capacity,
        price,
        location: "test",
        // 모집 중(모집 시작 ≤ 지금 < 개강). recruit_opens_at은 기본값이 없다.
        recruit_opens_at: new Date(Date.now() - 3_600_000).toISOString(),
        opens_at: new Date(Date.now() + 86_400_000).toISOString(),
        status: "OPEN",
        grants: [],
        required_terms_types: [],
      })
      .select("id")
      .single();
    if (error || !offering) throw new Error(error?.message);
    return offering.id;
  }

  async function createStudent() {
    const email = `vitest-coded-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(authError?.message);
    cleanupAuthIds.push(authUser.user.id);
    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({ auth_user_id: authUser.user.id, email, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(profileError?.message);
    cleanupUserIds.push(profile.id);
    return profile.id as string;
  }

  async function insertOrder(input: {
    userId: string;
    offeringId: string;
    status: string;
    paymentStatus: string;
    finalAmount: number;
    refundedAmount?: number;
  }) {
    const id = randomUUID();
    const paid = input.paymentStatus === "PAID" || input.paymentStatus === "PARTIALLY_REFUNDED";
    const { error } = await admin.from("orders").insert({
      id,
      user_id: input.userId,
      course_offering_id: input.offeringId,
      status: input.status,
      payment_status: input.paymentStatus,
      list_price: input.finalAmount,
      final_amount: input.finalAmount,
      refunded_amount: input.refundedAmount ?? 0,
      approved_at: input.status === "APPROVED" || paid ? new Date().toISOString() : null,
      cancelled_at: input.status === "CANCELLED" ? new Date().toISOString() : null,
      paid_at: paid ? new Date().toISOString() : null,
      payment_method: paid ? "CARD" : null,
      refunded_at:
        input.paymentStatus === "REFUNDED" ? new Date().toISOString() : null,
    });
    if (error) throw new Error(error.message);
    const { data: off } = await admin
      .from("course_offerings")
      .select("remaining_seats")
      .eq("id", input.offeringId)
      .single();
    if (off && off.remaining_seats > 0) {
      await admin
        .from("course_offerings")
        .update({ remaining_seats: off.remaining_seats - 1 })
        .eq("id", input.offeringId);
    }
    return id;
  }

  async function attachTossPayment(orderId: string, amount: number) {
    Object.assign(process.env, fakePgEnvOverrides());
    const origin = getFakePgOrigin();
    const body = new URLSearchParams({
      orderId,
      amount: String(amount),
      successUrl: "http://127.0.0.1:3000/r",
      failUrl: "http://127.0.0.1:3000/r",
      webhookUrl: `${origin}/__control/toss/webhook`,
    });
    const res = await fetch(`${origin}/toss/checkout/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (!location) throw new Error("checkout Location 없음");
    const u = new URL(location);
    const paymentKey = u.searchParams.get("paymentKey")!;
    await tossProvider.completeReturn(
      {
        paymentKey,
        orderId: u.searchParams.get("orderId")!,
        amount: u.searchParams.get("amount")!,
      },
      amount,
      orderId,
    );
    const { error } = await admin.from("payment_events").insert({
      provider: "TOSS",
      provider_event_id: `toss-paid:${paymentKey}`,
      provider_transaction_id: paymentKey,
      event_type: "PAYMENT_SUCCEEDED",
      amount,
      currency: "KRW",
      order_id: orderId,
      payment_method: "CARD",
    });
    if (error) throw new Error(error.message);
    return paymentKey;
  }

  async function applyRefundWebhooks(paymentKey: string, orderId: string) {
    const events = await tossProvider.receiveWebhook(
      JSON.stringify({
        eventType: "PAYMENT_STATUS_CHANGED",
        data: { paymentKey, status: "CANCELED" },
      }),
      new Headers(),
    );
    for (const ev of events) {
      if (ev.eventType !== "REFUNDED") continue;
      await confirmPayment({
        provider: "TOSS",
        providerEventId: ev.providerEventId,
        providerTransactionId: ev.providerTransactionId,
        eventType: "REFUNDED",
        amount: ev.amount,
        currency: "KRW",
        orderId,
        paymentMethod: "CARD",
        raw: ev.raw,
      });
    }
  }

  async function closeWithoutRefund(orderId: string, reason = "테스트 환불 없이 종료") {
    return admin.rpc("close_order_without_refund", {
      p_order_id: orderId,
      p_actor_id: actorId,
      p_actor_role: "ADMIN",
      p_reason: reason,
    });
  }

  it("폐강 시작은 결제·0원 결제 건을 건드리지 않는다(자동 환불 없음) → 학생별 처리(전액 환불 / 환불 없이 종료) → 모두 처리돼야 완료", async () => {
    const t0 = new Date();
    const oid = await ensureOffering(10, 50000);
    const u1 = await createStudent();
    const u2 = await createStudent();
    const u3 = await createStudent();
    const u4 = await createStudent();
    const u0 = await createStudent();

    const paid1 = await insertOrder({ userId: u1, offeringId: oid, status: "APPROVED", paymentStatus: "PAID", finalAmount: 50000 });
    const paid2 = await insertOrder({ userId: u2, offeringId: oid, status: "APPROVED", paymentStatus: "PAID", finalAmount: 50000 });
    const unpaidApproved = await insertOrder({ userId: u3, offeringId: oid, status: "APPROVED", paymentStatus: "UNPAID", finalAmount: 50000 });
    const pending = await insertOrder({ userId: u4, offeringId: oid, status: "PENDING", paymentStatus: "UNPAID", finalAmount: 50000 });
    const zeroPaid = await insertOrder({ userId: u0, offeringId: oid, status: "APPROVED", paymentStatus: "PAID", finalAmount: 0 });

    const key1 = await attachTossPayment(paid1, 50000);
    await attachTossPayment(paid2, 50000);

    // paid2에는 이용권이 있다 — 환불 없이 종료하면 ORDER_CLOSED 사실로 회수돼야 한다.
    const { data: paid2Payment } = await admin
      .from("payment_events")
      .select("id")
      .eq("order_id", paid2)
      .eq("event_type", "PAYMENT_SUCCEEDED")
      .single();
    const { error: grantError } = await admin.rpc("grant_entitlements_for_order", {
      p_order_id: paid2,
      p_user_id: u2,
      p_source: "PAYMENT",
      p_source_id: paid2Payment!.id,
      p_grants: null,
    });
    if (grantError) throw new Error(grantError.message);

    const { data: affected, error } = await admin.rpc("cancel_course_offering", {
      p_offering_id: oid,
      p_reason: "테스트 폐강",
      p_actor: actorId,
      p_actor_role: "ADMIN",
    });
    if (error) throw new Error(error.message);

    // 결제 전 신청만 자동 정리, 결제 완료·0원 결제는 관리자 처리 대기(ACTION_REQUIRED).
    const actions = new Map((affected as { order_id: string; action: string }[]).map((r) => [r.order_id, r.action]));
    expect(actions.get(pending)).toBe("REJECTED");
    expect(actions.get(unpaidApproved)).toBe("CANCELLED");
    expect(actions.get(paid1)).toBe("ACTION_REQUIRED");
    expect(actions.get(paid2)).toBe("ACTION_REQUIRED");
    expect(actions.get(zeroPaid)).toBe("ACTION_REQUIRED");

    // 자동 환불이 없다: 주문 불변, 폐강 환불 사실 미적재, 드레인 뒤에도 환불 요청 0건.
    const { data: untouched } = await admin.from("orders").select("id, status, payment_status").in("id", [paid1, paid2, zeroPaid]);
    for (const o of untouched ?? []) expect(o).toMatchObject({ status: "APPROVED", payment_status: "PAID" });
    const { data: oldTopic } = await admin.from("outbox_messages").select("id").eq("topic", "ORDER_OFFERING_CANCELLED").contains("payload", { order_id: paid1 });
    expect(oldTopic ?? []).toHaveLength(0);
    Object.assign(process.env, fakePgEnvOverrides());
    await runOutboxBatch();
    const { data: requests } = await admin.from("payment_events").select("id").in("order_id", [paid1, paid2]).eq("event_type", "REFUND_REQUESTED");
    expect(requests ?? []).toHaveLength(0);

    // 처리 안 된 수강생이 있으면 폐강 완료 불가(강제 통과 없음).
    const early = await admin.rpc("complete_course_offering_cancel", { p_offering_id: oid, p_actor: actorId, p_actor_role: "ADMIN" });
    expect(early.error?.message).toContain("남은 3건");

    // paid1: 전액 환불(PG) — 요청은 비동기라 웹훅이 와야 주문이 정리된다.
    const refund = await requestRefund({ orderId: paid1, amount: null, reason: "폐강", requestKey: randomUUID(), source: "OFFERING_CANCEL", actorId });
    expect(refund.result).toBe("SUBMITTED");
    expect((await ordersWithOpenRefundRequest([paid1])).has(paid1)).toBe(true);
    expect((await findOfferingCancelBlockers(oid)).some((b) => b.orderId === paid1)).toBe(true);
    for (let attempt = 0; attempt < 3; attempt++) {
      await applyRefundWebhooks(key1, paid1);
      await runOutboxBatch();
      const { data: check } = await admin.from("orders").select("payment_status").eq("id", paid1).single();
      if (check?.payment_status === "REFUNDED") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const { data: refunded } = await admin.from("orders").select("status, payment_status").eq("id", paid1).single();
    expect(refunded).toMatchObject({ status: "CANCELLED", payment_status: "REFUNDED" });

    // paid2·zeroPaid: 환불 없이 종료 — 수강만 종료, 결제 상태·금액은 그대로.
    for (const id of [paid2, zeroPaid]) {
      const closed = await closeWithoutRefund(id);
      expect(closed.error).toBeNull();
      const { data: o } = await admin.from("orders").select("status, payment_status, cancelled_at").eq("id", id).single();
      expect(o).toMatchObject({ status: "CANCELLED", payment_status: "PAID" });
      expect(o?.cancelled_at).not.toBeNull();
      const { data: ev } = await admin.from("order_events").select("event_type, actor, payload").eq("order_id", id).eq("event_type", "CLOSED");
      expect(ev).toHaveLength(1);
      expect(ev![0]).toMatchObject({ actor: "ADMIN", payload: { reason: "테스트 환불 없이 종료", mode: "NO_REFUND" } });
    }
    // 이중 호출은 거부된다.
    expect((await closeWithoutRefund(paid2)).error?.message).toContain("승인된 신청 건만");

    // ORDER_CLOSED 사실 → 이용권 회수(ADMIN_CLOSED).
    await runOutboxBatch();
    const { data: ents } = await admin.from("entitlements").select("revoked_at, revoked_reason").eq("order_id", paid2);
    expect(ents).toHaveLength(1);
    expect(ents![0].revoked_reason).toBe("ADMIN_CLOSED");
    expect(ents![0].revoked_at).not.toBeNull();

    // 모두 처리됨 → 원장 쪽 막힘 없음 → 완료.
    expect(await findOfferingCancelBlockers(oid)).toEqual([]);
    const { error: completeError } = await admin.rpc("complete_course_offering_cancel", { p_offering_id: oid, p_actor: actorId, p_actor_role: "ADMIN" });
    expect(completeError).toBeNull();
    const { data: off } = await admin.from("course_offerings").select("status").eq("id", oid).single();
    expect(off?.status).toBe("CANCELLED");

    // 이 흐름이 새 DLQ를 만들지 않았다.
    for (const id of [paid1, paid2, unpaidApproved, pending, zeroPaid]) {
      const { data: dlqRows, error: dlqError } = await admin
        .from("dead_letters")
        .select("id, error_message, payload, created_at")
        .gte("created_at", t0.toISOString());
      if (dlqError) throw new Error(dlqError.message);
      const hits = (dlqRows ?? []).filter((r) => {
        if (typeof r.error_message === "string" && r.error_message.includes(id)) return true;
        const payload = r.payload;
        return !!payload && typeof payload === "object" && !Array.isArray(payload) && (payload as Record<string, unknown>).order_id === id;
      });
      expect(hits, `주문 ${id} 새 DLQ: ${JSON.stringify(hits)}`).toHaveLength(0);
    }
  });

  it("부분 환불이 반영되면 신청이 종료돼(수강 포기, S-4a) 처리가 끝나고 폐강을 마무리할 수 있다 — 남은 금액은 추가로 환불해도 DLQ가 아니다", async () => {
    const oid = await ensureOffering(5, 40000);
    {
      const { error: statusError } = await admin
        .from("course_offerings")
        .update({ status: "CANCELLING", status_reason: "테스트 폐강", status_changed_by: actorId, status_changed_at: new Date().toISOString() })
        .eq("id", oid);
      if (statusError) throw new Error(`폐강 진행 상태 픽스처 실패: ${statusError.message}`);
    }
    const userId = await createStudent();
    const orderId = await insertOrder({ userId, offeringId: oid, status: "APPROVED", paymentStatus: "PAID", finalAmount: 40000 });
    await attachTossPayment(orderId, 40000);

    // 부분 환불(PG 외 기록)을 반영하면 PARTIALLY_REFUNDED로 주문이 끝난다 — 처리할 학생이 남지 않는다.
    await confirmPayment({
      provider: "MANUAL",
      providerEventId: `manual-refund:${randomUUID()}`,
      eventType: "REFUNDED",
      amount: 10000,
      currency: "KRW",
      orderId,
      paymentMethod: "BANK_TRANSFER",
      metadata: { reason: "부분 환불", source: "ADMIN_MANUAL_REFUND" },
      raw: { manual: true },
    });
    await runOutboxBatch(); // PAYMENT_REFUNDED 사실 → 주문 반영
    const { data: partial } = await admin.from("orders").select("status, payment_status, refunded_amount").eq("id", orderId).single();
    expect(partial).toMatchObject({ status: "CANCELLED", payment_status: "PARTIALLY_REFUNDED", refunded_amount: 10000 });
    const { data: cancelEvent } = await admin.from("order_events").select("payload").eq("order_id", orderId).eq("event_type", "CANCELLED").single();
    expect(cancelEvent?.payload).toMatchObject({ cause: "ADMIN_REFUND", reason: "부분 환불", partial: true, refunded_total: 10000, final_amount: 40000 });
    expect(await findOfferingCancelBlockers(oid)).toEqual([]);
    const done = await admin.rpc("complete_course_offering_cancel", { p_offering_id: oid, p_actor: actorId, p_actor_role: "ADMIN" });
    expect(done.error).toBeNull();

    // 남은 30000원 추가 환불 — 누적되어 REFUNDED가 되고 DLQ·종료 사건 중복이 없다.
    await confirmPayment({
      provider: "MANUAL",
      providerEventId: `manual-refund:${randomUUID()}`,
      eventType: "REFUNDED",
      amount: 30000,
      currency: "KRW",
      orderId,
      paymentMethod: "BANK_TRANSFER",
      metadata: { reason: "잔액 환불", source: "ADMIN_MANUAL_REFUND" },
      raw: { manual: true },
    });
    await runOutboxBatch();
    const { data: full } = await admin.from("orders").select("status, payment_status, refunded_amount").eq("id", orderId).single();
    expect(full).toMatchObject({ status: "CANCELLED", payment_status: "REFUNDED", refunded_amount: 40000 });
    const { data: events } = await admin.from("order_events").select("id").eq("order_id", orderId).eq("event_type", "CANCELLED");
    expect(events).toHaveLength(1);
  });

  it("고아 결제(주문은 취소·미결제인데 원장에 결제 성공이 남음)는 서버 쪽 완료 확인이 막고, 환불로 정리되면 풀린다", async () => {
    const oid = await ensureOffering(5, 30000);
    {
      const { error: statusError } = await admin
        .from("course_offerings")
        .update({ status: "CANCELLING", status_reason: "테스트 폐강", status_changed_by: actorId, status_changed_at: new Date().toISOString() })
        .eq("id", oid);
      if (statusError) throw new Error(`폐강 진행 상태 픽스처 실패: ${statusError.message}`);
    }
    const userId = await createStudent();
    const orderId = await insertOrder({ userId, offeringId: oid, status: "CANCELLED", paymentStatus: "UNPAID", finalAmount: 30000 });
    await attachTossPayment(orderId, 30000);

    const blockers = await findOfferingCancelBlockers(oid);
    expect(blockers.map((b) => b.orderId)).toContain(orderId);
    expect(blockers.find((b) => b.orderId === orderId)?.reason).toContain("고아 결제");
    // DB 함수는 원장을 못 보므로(R1) 통과시킨다 — 그래서 서버 액션이 위 확인을 먼저 한다.
    // (여기서는 환불 원장을 쌓아 정리되는지만 본다.)
    await admin.from("payment_events").insert({
      provider: "TOSS",
      provider_event_id: `vitest-orphan-refund-${randomUUID()}`,
      event_type: "REFUNDED",
      amount: 30000,
      currency: "KRW",
      order_id: orderId,
      payment_method: "CARD",
    });
    expect((await findOfferingCancelBlockers(oid)).map((b) => b.orderId)).not.toContain(orderId);
  });

  it("PG 거절 1건 → PG 외 환불 반영 → 완료 가능", async () => {
    // 이전 테스트와 개설을 공유하지 않는다(상태 잔여 방지).
    const { data: offering, error: offErr } = await admin
      .from("course_offerings")
      .insert({
        course_id: courseId!,
        label: "E4-reject",
        capacity: 5,
        remaining_seats: 5,
        price: 28000,
        location: "test",
        // 모집 중(모집 시작 ≤ 지금 < 개강). recruit_opens_at은 기본값이 없다.
        recruit_opens_at: new Date(Date.now() - 3_600_000).toISOString(),
        opens_at: new Date(Date.now() + 86_400_000).toISOString(),
        status: "OPEN",
        grants: [],
        required_terms_types: [],
      })
      .select("id")
      .single();
    if (offErr || !offering) throw new Error(offErr?.message);
    const oid = offering.id;

    const userId = await createStudent();
    const orderId = await insertOrder({ userId, offeringId: oid, status: "APPROVED", paymentStatus: "PAID", finalAmount: 28000 });
    const paymentKey = await attachTossPayment(orderId, 28000);

    const { error } = await admin.rpc("cancel_course_offering", { p_offering_id: oid, p_reason: "테스트 폐강", p_actor: actorId, p_actor_role: "ADMIN" });
    if (error) throw new Error(error.message);

    // 관리자가 전액 환불을 요청했지만 PG가 거절한다 — 요청은 실패로 닫히고 주문은 그대로 남는다.
    await setTossCancelBehavior(paymentKey, "reject_403");
    await expect(
      requestRefund({ orderId, amount: null, reason: "폐강", requestKey: randomUUID(), source: "OFFERING_CANCEL", actorId }),
    ).rejects.toThrow();
    expect((await ordersWithOpenRefundRequest([orderId])).has(orderId)).toBe(false);

    await confirmPayment({
      provider: "MANUAL",
      providerEventId: `manual-refund:${randomUUID()}`,
      eventType: "REFUNDED",
      amount: 28000,
      currency: "KRW",
      orderId,
      paymentMethod: "BANK_TRANSFER",
      metadata: { reason: "PG 외" },
      raw: { manual: true },
    });
    await runOutboxBatch();

    const { error: completeError } = await admin.rpc("complete_course_offering_cancel", { p_offering_id: oid, p_actor: actorId, p_actor_role: "ADMIN" });
    expect(completeError).toBeNull();

    // 결제 원장·주문·상품(·주문 이벤트) 및 이용권은 지우지 않는다 — 잔여는 db:reset.
    await admin.from("outbox_messages").delete().contains("payload", { order_id: orderId });
  });
});
