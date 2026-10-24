import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { checkSystemIntegrity } from "./checks";

/**
 * 대사 ⑤ — 갈래 2(끝난 주문: CLOSED_ORDER_WITH_ACTIVE_ENTITLEMENTS)와
 * 갈래 3(종료된 강의: ENDED_OFFERING_WITH_ACTIVE_ENTITLEMENTS).
 * 환불 없는 종료(ADMIN_CLOSED)와 종료된 강의까지 점검 대상이 넓어졌다.
 * 로컬 Supabase 필요, 외부 호출 없음.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다. .env.local을 확인하고 " +
      "`npm run db:start`로 로컬 Supabase를 띄운 뒤 다시 실행하세요.",
  );
}

const admin = createClient(url, key, { auth: { persistSession: false } });

describe("대사 ⑤ 끝난 주문 및 종료 강의의 활성 이용권 점검 — 통합", { timeout: 60_000 }, () => {
  let authUserId: string | null = null;
  let profileId: string | null = null;
  let orderId: string | null = null;
  let offeringId: string | null = null;

  afterEach(async () => {
    // dead_letters 정리
    if (orderId) {
      await admin
        .from("dead_letters")
        .delete()
        .eq("source", "INTEGRITY")
        .contains("payload", { order_id: orderId });
    }
    if (offeringId) {
      await admin
        .from("course_sessions")
        .update({ deactivated_at: new Date().toISOString(), deactivated_reason: "vitest teardown" })
        .eq("course_offering_id", offeringId);
      await admin
        .from("course_offerings")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", offeringId);
    }
    orderId = null;
    offeringId = null;
    if (profileId) {
      await admin
        .from("users")
        .update({ withdrawn_at: new Date().toISOString() })
        .eq("id", profileId);
      profileId = null;
    }
    if (authUserId) {
      await admin.auth.admin.deleteUser(authUserId);
      authUserId = null;
    }
  });

  function randomFutureDate() {
    const year = 2040 + Math.floor(Math.random() * 20);
    const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
    const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  async function seedOrder(opts: {
    paymentStatus?: "PARTIALLY_REFUNDED" | "REFUNDED" | "WAIVED" | "UNPAID";
    status?: "CANCELLED" | "APPROVED";
    cancelledMinutesAgo?: number;
    entitlementRevoked: boolean;
  }) {
    const email = `vitest-revoke-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (authError || !authUser.user) throw new Error(`auth 생성 실패: ${authError?.message}`);
    authUserId = authUser.user.id;
    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({ auth_user_id: authUserId, email, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(`프로필 실패: ${profileError?.message}`);
    profileId = profile.id;

    const { data: product, error: productError } = await admin
      .from("products")
      .insert({ name: `vitest-revoke-${randomUUID()}`, price: 30000 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`상품 실패: ${productError?.message}`);

    orderId = randomUUID();
    const paidAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const minutesAgo = opts.cancelledMinutesAgo ?? 20; // 기본은 10분 유예 밖
    const cancelledTime = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const status = opts.status ?? "CANCELLED";
    const paymentStatus = opts.paymentStatus ?? "PARTIALLY_REFUNDED";

    const { error: orderError } = await admin.from("orders").insert({
      id: orderId,
      user_id: profileId,
      product_id: product.id,
      status,
      payment_status: paymentStatus,
      approved_at: paidAt,
      paid_at: paymentStatus === "WAIVED" || paymentStatus === "UNPAID" ? null : paidAt,
      cancelled_at: status === "CANCELLED" ? cancelledTime : null,
      refunded_at: paymentStatus === "REFUNDED" ? cancelledTime : null,
      list_price: 30000,
      final_amount: 30000,
      payment_method: paymentStatus === "WAIVED" || paymentStatus === "UNPAID" ? null : "CARD",
      refunded_amount: paymentStatus === "REFUNDED" ? 30000 : paymentStatus === "PARTIALLY_REFUNDED" ? 15000 : 0,
    });
    if (orderError) throw new Error(`주문 실패: ${orderError.message}`);

    const { data: paidEvent, error: eventError } = await admin
      .from("payment_events")
      .insert({
        provider: "MOCK",
        provider_event_id: `vitest-revoke-${randomUUID()}`,
        event_type: "PAYMENT_SUCCEEDED",
        amount: 30000,
        currency: "KRW",
        order_id: orderId,
      })
      .select("id")
      .single();
    if (eventError || !paidEvent) throw new Error(`결제 이벤트 실패: ${eventError?.message}`);

    const { error: entError } = await admin.from("entitlements").insert({
      user_id: profileId,
      type: "COURSE_ACCESS",
      order_id: orderId,
      payment_event_id: paidEvent.id,
      access_code: `vitest-${randomUUID()}`,
      revoked_at: opts.entitlementRevoked ? cancelledTime : null,
      revoked_reason: opts.entitlementRevoked ? "REFUND" : null,
    });
    if (entError) throw new Error(`이용권 실패: ${entError.message}`);
    return orderId;
  }

  async function closedWarnings(oid: string) {
    const { data, error } = await admin
      .from("dead_letters")
      .select("payload")
      .eq("source", "INTEGRITY")
      .contains("payload", { order_id: oid, check: "CLOSED_ORDER_WITH_ACTIVE_ENTITLEMENTS" });
    if (error) throw new Error(`dead_letters 조회 실패: ${error.message}`);
    return data ?? [];
  }

  async function endedOfferingWarnings(oid: string) {
    const { data, error } = await admin
      .from("dead_letters")
      .select("payload")
      .eq("source", "INTEGRITY")
      .contains("payload", { order_id: oid, check: "ENDED_OFFERING_WITH_ACTIVE_ENTITLEMENTS" });
    if (error) throw new Error(`dead_letters 조회 실패: ${error.message}`);
    return data ?? [];
  }

  describe("갈래 2 — 끝난 주문의 활성 이용권", () => {
    it("부분 환불로 끝난 주문에 회수 안 된 이용권이 남으면 경고한다", async () => {
      const oid = await seedOrder({ paymentStatus: "PARTIALLY_REFUNDED", entitlementRevoked: false });
      await checkSystemIntegrity();
      expect((await closedWarnings(oid)).length).toBeGreaterThanOrEqual(1);
    });

    it("부분 환불로 끝난 주문의 이용권이 회수돼 있으면 경고하지 않는다", async () => {
      const oid = await seedOrder({ paymentStatus: "PARTIALLY_REFUNDED", entitlementRevoked: true });
      await checkSystemIntegrity();
      expect(await closedWarnings(oid)).toHaveLength(0);
    });

    it("전액 환불 주문에 회수 안 된 이용권이 남으면 경고한다", async () => {
      const oid = await seedOrder({ paymentStatus: "REFUNDED", entitlementRevoked: false });
      await checkSystemIntegrity();
      expect((await closedWarnings(oid)).length).toBeGreaterThanOrEqual(1);
    });

    it("환불 없는 취소 주문(예: 결제면제 WAIVED 후 CANCELLED)에 활성 이용권이 남으면 경고한다", async () => {
      const oid = await seedOrder({ paymentStatus: "WAIVED", status: "CANCELLED", entitlementRevoked: false });
      await checkSystemIntegrity();
      expect((await closedWarnings(oid)).length).toBeGreaterThanOrEqual(1);
    });

    it("취소된 지 10분이 안 된 주문(유예 기간)은 경고하지 않는다", async () => {
      const oid = await seedOrder({
        paymentStatus: "REFUNDED",
        cancelledMinutesAgo: 5,
        entitlementRevoked: false,
      });
      await checkSystemIntegrity();
      expect(await closedWarnings(oid)).toHaveLength(0);
    });
  });

  async function ensureAdmin(): Promise<string> {
    const { data } = await admin.from("users").select("id").eq("role", "ADMIN").limit(1).maybeSingle();
    if (data?.id) return data.id;
    const email = `vitest-adm-${randomUUID()}@example.com`;
    const { data: authUser } = await admin.auth.admin.createUser({ email, email_confirm: true });
    const { data: created } = await admin.from("users").insert({ auth_user_id: authUser!.user!.id, email, role: "ADMIN" }).select("id").single();
    return created!.id;
  }

  describe("갈래 3 — 종료된 강의의 활성 이용권", () => {
    it("강의가 종료된 지 10분이 넘었는데 승인된 주문에 활성 이용권이 남아 있으면 경고한다", async () => {
      // 1. 강사/강의 생성
      const email = `vitest-ended-${randomUUID()}@example.com`;
      const { data: authUser } = await admin.auth.admin.createUser({ email, email_confirm: true });
      authUserId = authUser!.user!.id;
      const { data: student } = await admin
        .from("users")
        .insert({ auth_user_id: authUserId, email, role: "STUDENT" })
        .select("id")
        .single();
      profileId = student!.id;

      const { data: course } = await admin
        .from("courses")
        .insert({ name: `vitest-ended-course-${randomUUID()}`, category: "TEST" })
        .select("id")
        .single();

      // 2. 개설강의 생성 (1회차)
      const adminId = await ensureAdmin();
      const { data: offering, error: offErr } = await admin.rpc("create_course_offering", {
        p_course_id: course!.id,
        p_label: "F1-종료테스트",
        p_capacity: 5,
        p_price: 10000,
        p_location: null,
        p_required_terms_types: [],
        p_grants: [],
        p_recruit_opens_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        p_sessions: [{ date: randomFutureDate(), start: "10:00", end: "12:00" }],
        p_actor: adminId,
        p_actor_role: "ADMIN",
      });
      if (offErr) throw new Error(`개설강의 생성 실패: ${offErr.message}`);
      offeringId = offering;

      // 3. 주문 생성 (APPROVED)
      orderId = randomUUID();
      await admin.from("orders").insert({
        id: orderId,
        user_id: profileId,
        course_offering_id: offeringId,
        status: "APPROVED",
        approved_at: new Date().toISOString(),
        payment_status: "PAID",
        paid_at: new Date().toISOString(),
        list_price: 10000,
        final_amount: 10000,
        payment_method: "CARD",
      });

      // 4. 활성 이용권 부여
      const { data: ordEvt, error: ordEvtErr } = await admin
        .from("order_events")
        .insert({ order_id: orderId, event_type: "APPROVED", actor: "ADMIN" })
        .select("id")
        .single();
      if (ordEvtErr || !ordEvt) throw new Error(`주문 이벤트 생성 실패: ${ordEvtErr?.message}`);

      const { error: entErr } = await admin.from("entitlements").insert({
        user_id: profileId,
        type: "COURSE_ACCESS",
        order_id: orderId,
        access_code: `vitest-${randomUUID()}`,
        grant_source: "ADMIN_GRANT",
        grant_event_id: ordEvt.id,
      });
      if (entErr) throw new Error(`이용권 생성 실패: ${entErr.message}`);

      // 5. 강의 종료 처리: ended_at을 20분 전으로 설정
      const endedTime = new Date(Date.now() - 20 * 60_000).toISOString();
      const { error: updErr } = await admin
        .from("course_offerings")
        .update({ ended_at: endedTime, end_note: "F-1 테스트 종료" })
        .eq("id", offeringId);
      if (updErr) throw new Error(`강의 종료 실패: ${updErr.message}`);

      // 6. 점검 실행
      await checkSystemIntegrity();

      // 검증
      expect((await endedOfferingWarnings(orderId)).length).toBeGreaterThanOrEqual(1);
    });

    it("강의 종료 시 이용권이 이미 회수되었으면 경고하지 않는다", async () => {
      const email = `vitest-ended2-${randomUUID()}@example.com`;
      const { data: authUser } = await admin.auth.admin.createUser({ email, email_confirm: true });
      authUserId = authUser!.user!.id;
      const { data: student } = await admin
        .from("users")
        .insert({ auth_user_id: authUserId, email, role: "STUDENT" })
        .select("id")
        .single();
      profileId = student!.id;

      const { data: course } = await admin
        .from("courses")
        .insert({ name: `vitest-ended-course-${randomUUID()}`, category: "TEST" })
        .select("id")
        .single();

      const adminId = await ensureAdmin();
      const { data: offering, error: offErr } = await admin.rpc("create_course_offering", {
        p_course_id: course!.id,
        p_label: "F1-종료테스트2",
        p_capacity: 5,
        p_price: 10000,
        p_location: null,
        p_required_terms_types: [],
        p_grants: [],
        p_recruit_opens_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        p_sessions: [{ date: randomFutureDate(), start: "10:00", end: "12:00" }],
        p_actor: adminId,
        p_actor_role: "ADMIN",
      });
      if (offErr) throw new Error(`개설강의 생성 실패: ${offErr.message}`);
      offeringId = offering;

      orderId = randomUUID();
      await admin.from("orders").insert({
        id: orderId,
        user_id: profileId,
        course_offering_id: offeringId,
        status: "APPROVED",
        approved_at: new Date().toISOString(),
        payment_status: "PAID",
        paid_at: new Date().toISOString(),
        list_price: 10000,
        final_amount: 10000,
        payment_method: "CARD",
      });

      const { data: ordEvt, error: ordEvtErr } = await admin
        .from("order_events")
        .insert({ order_id: orderId, event_type: "APPROVED", actor: "ADMIN" })
        .select("id")
        .single();
      if (ordEvtErr || !ordEvt) throw new Error(`주문 이벤트 생성 실패: ${ordEvtErr?.message}`);

      // 이미 회수된 이용권
      const { error: entErr } = await admin.from("entitlements").insert({
        user_id: profileId,
        type: "COURSE_ACCESS",
        order_id: orderId,
        access_code: `vitest-${randomUUID()}`,
        grant_source: "ADMIN_GRANT",
        grant_event_id: ordEvt.id,
        revoked_at: new Date().toISOString(),
        revoked_reason: "COURSE_ENDED",
      });
      if (entErr) throw new Error(`이용권 생성 실패: ${entErr.message}`);

      const endedTime = new Date(Date.now() - 20 * 60_000).toISOString();
      const { error: updErr } = await admin
        .from("course_offerings")
        .update({ ended_at: endedTime, end_note: "F-1 테스트 종료" })
        .eq("id", offeringId);
      if (updErr) throw new Error(`강의 종료 실패: ${updErr.message}`);

      await checkSystemIntegrity();
      expect(await endedOfferingWarnings(orderId)).toHaveLength(0);
    });
  });
});
