import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { checkSystemIntegrity } from "./checks";

/**
 * S-3(2026-10-08) — 대사 ②가 결제 진행 중 폐강·취소로 생긴 고아 결제(주문 CANCELLED·UNPAID인데 원장에 결제 성공)를
 * 관리자가 환불 없이 DLQ를 해결 처리한 뒤에도 다시 잡는지, 환불로 정리된 건 경고하지 않는지.
 * 로컬 Supabase 필요(`npm run test:integration`). 외부 호출 없음.
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
const AMOUNT = 30000;

describe("대사 ② 고아 결제 — 통합", () => {
  let authUserId: string | null = null;
  let profileId: string | null = null;
  let orderId: string | null = null;

  afterEach(async () => {
    if (orderId) {
      // 원장은 append-only라 지울 수 없다 — 이 주문이 이후 대사에서 계속 경고되지 않게 잔액을 0으로 만들어 둔다.
      const { data: ledger } = await admin
        .from("payment_events")
        .select("event_type, amount")
        .eq("order_id", orderId)
        .in("event_type", ["PAYMENT_SUCCEEDED", "REFUNDED"]);
      const net = (ledger ?? []).reduce(
        (sum, row) => sum + (row.event_type === "REFUNDED" ? -1 : 1) * (row.amount ?? 0),
        0,
      );
      if (net > 0) await insertRefund(orderId, net);
      const { error } = await admin.from("dead_letters").delete().contains("payload", { order_id: orderId });
      if (error) throw new Error(`dead_letters 정리 실패: ${error.message}`);
    }
    orderId = null;
    if (profileId) {
      await admin.from("users").update({ withdrawn_at: new Date().toISOString() }).eq("id", profileId);
      profileId = null;
    }
    if (authUserId) {
      await admin.auth.admin.deleteUser(authUserId);
      authUserId = null;
    }
  });

  async function insertRefund(oid: string, amount: number) {
    const { error } = await admin.from("payment_events").insert({
      provider: "TOSS",
      provider_event_id: `vitest-orphan-refund-${randomUUID()}`,
      event_type: "REFUNDED",
      amount,
      currency: "KRW",
      order_id: oid,
    });
    if (error) throw new Error(`환불 행 실패: ${error.message}`);
  }

  /** 폐강으로 취소된 주문(CANCELLED·UNPAID) + 20분 전 결제 성공 원장 + on_payment_succeeded가 남겼을 DLQ 1행. */
  async function seedOrphan(dlqResolved: boolean) {
    const email = `vitest-orphan-${randomUUID()}@example.com`;
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
      .insert({ name: `vitest-orphan-${randomUUID()}`, price: AMOUNT })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`상품 실패: ${productError?.message}`);

    orderId = randomUUID();
    const { error: orderError } = await admin.from("orders").insert({
      id: orderId,
      user_id: profileId,
      product_id: product.id,
      status: "CANCELLED", // 폐강이 APPROVED 주문을 CANCELLED로 바꾼 상태(cancel_course_offering)
      payment_status: "UNPAID",
      approved_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      cancelled_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      list_price: AMOUNT,
      final_amount: AMOUNT,
    });
    if (orderError) throw new Error(`주문 실패: ${orderError.message}`);

    const { data: paid, error: paidError } = await admin
      .from("payment_events")
      .insert({
        provider: "TOSS",
        provider_event_id: `vitest-orphan-paid-${randomUUID()}`,
        event_type: "PAYMENT_SUCCEEDED",
        amount: AMOUNT,
        currency: "KRW",
        order_id: orderId,
        created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      })
      .select("id")
      .single();
    if (paidError || !paid) throw new Error(`결제 성공 행 실패: ${paidError?.message}`);

    const { error: dlqError } = await admin.from("dead_letters").insert({
      source: "TOSS",
      payload: { handler: "on_payment_succeeded", payment_event_id: paid.id, order_id: orderId },
      error_message: "vitest — 주문 상태가 APPROVED가 아닌 건에 결제성공 이벤트가 들어옴",
      ...(dlqResolved
        ? { resolved: true, resolved_at: new Date().toISOString(), resolution_reason: "vitest — 환불 없이 해결 처리" }
        : {}),
    });
    if (dlqError) throw new Error(`DLQ 행 실패: ${dlqError.message}`);

    return { orderId, paymentEventId: paid.id as string };
  }

  async function integrityWarnings(paymentEventId: string) {
    const { data, error } = await admin
      .from("dead_letters")
      .select("error_message")
      .eq("source", "INTEGRITY")
      .contains("payload", { payment_event_id: paymentEventId });
    if (error) throw new Error(`dead_letters 조회 실패: ${error.message}`);
    return data ?? [];
  }

  it("DLQ를 환불 없이 해결 처리한 고아 결제는 대사 ②가 다시 경고한다", async () => {
    const { paymentEventId } = await seedOrphan(true);
    await checkSystemIntegrity();

    const rows = await integrityWarnings(paymentEventId);
    // 1건 이상: 병렬로 도는 다른 파일의 대사와 겹치면 중복 방지(조회 후 INSERT)가 원자적이지 않다.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.error_message).toContain("고아 결제");
    expect(rows[0]?.error_message).toContain("미환불 30,000원");
  });

  it("전액 환불로 정리된 고아 결제는 경고하지 않는다", async () => {
    const { orderId: oid, paymentEventId } = await seedOrphan(true);
    await insertRefund(oid, AMOUNT);
    await checkSystemIntegrity();

    expect(await integrityWarnings(paymentEventId)).toHaveLength(0);
  });

  it("미해결 DLQ가 이미 있으면 중복 경고하지 않는다", async () => {
    const { paymentEventId } = await seedOrphan(false);
    await checkSystemIntegrity();

    expect(await integrityWarnings(paymentEventId)).toHaveLength(0);
  });
});
