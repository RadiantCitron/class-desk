import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import {
  confirmPayment,
  getRefundableAmount,
  markRefundRequestFailed,
  requestRefund,
} from "@/lib/payment";
import { tossProvider } from "@/lib/payment/providers/toss";
import {
  fakePgEnvOverrides,
  getFakePgOrigin,
  startFakePg,
  stopFakePg,
} from "@/lib/payment/providers/fake-pg-harness";

/**
 * Code-C — 관리자 출구(요청 실패 표시·PG 외 환불) 통합.
 * UI 액션은 이 파사드 경로를 그대로 탄다. `npm run test:integration`으로 실행.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다.",
  );
}

const admin = createClient(url, key, { auth: { persistSession: false } });

const ENV_KEYS = [
  "TOSS_SECRET_KEY",
  "NEXT_PUBLIC_TOSS_CLIENT_KEY",
  "TOSS_API_BASE_URL",
  "NEXT_PUBLIC_TOSS_SDK_URL",
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

describe("Code-C 관리자 환불 출구 — 통합", () => {
  let authUserId: string | null = null;
  let profileId: string | null = null;
  let productId: string | null = null;
  let adminProfileId: string | null = null;

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    await startFakePg();
    Object.assign(process.env, fakePgEnvOverrides());

    const { data: adminUser } = await admin
      .from("users")
      .select("id")
      .eq("role", "ADMIN")
      .limit(1)
      .single();
    adminProfileId = adminUser?.id ?? null;
  });

  afterAll(() => {
    stopFakePg();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  afterEach(async () => {
    // 결제 원장·주문·상품(·주문 이벤트)은 지우지 않는다 — 원장·이벤트는 DB 트리거가, 주문·상품은 FK가 막아 예전 delete는 대부분 조용히 실패했다. 잔여는 db:reset.
    productId = null;
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

  async function seedPaid(amount: number) {
    const email = `vitest-codec-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(authError?.message);
    authUserId = authUser.user.id;
    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({ auth_user_id: authUserId, email, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(profileError?.message);
    profileId = profile.id;

    const { data: product, error: productError } = await admin
      .from("products")
      .insert({ name: `vitest-codec-${randomUUID()}`, price: amount })
      .select("id")
      .single();
    if (productError || !product) throw new Error(productError?.message);
    productId = product.id;

    const orderId = randomUUID();
    const { error: orderError } = await admin.from("orders").insert({
      id: orderId,
      user_id: profileId,
      product_id: productId,
      status: "APPROVED",
      payment_status: "PAID",
      approved_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
      list_price: amount,
      final_amount: amount,
      payment_method: "CARD",
    });
    if (orderError) throw new Error(orderError.message);

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

    const { error: peError } = await admin.from("payment_events").insert({
      provider: "TOSS",
      provider_event_id: `toss-paid:${paymentKey}`,
      provider_transaction_id: paymentKey,
      event_type: "PAYMENT_SUCCEEDED",
      amount,
      currency: "KRW",
      order_id: orderId,
      payment_method: "CARD",
    });
    if (peError) throw new Error(peError.message);

    return { orderId, paymentKey, amount };
  }

  it("요청 실패로 표시 후 새 키로 재개시 가능", async () => {
    const { orderId, paymentKey } = await seedPaid(41000);
    const { setTossCancelBehavior } = await import(
      "@/lib/payment/providers/fake-pg-harness"
    );
    process.env.PG_CANCEL_TIMEOUT_MS = "600";
    Object.assign(process.env, fakePgEnvOverrides());
    await setTossCancelBehavior(paymentKey, "timeout_before_apply");
    await expect(
      requestRefund({
        orderId,
        amount: null,
        reason: "열기",
        requestKey: randomUUID(),
        source: "ADMIN",
        actorId: adminProfileId,
      }),
    ).rejects.toThrow(/다시 누르지 마세요/);

    await markRefundRequestFailed(orderId, "PG 콘솔에서 취소 없음");
    const again = await requestRefund({
      orderId,
      amount: null,
      reason: "재시도",
      requestKey: randomUUID(),
      source: "ADMIN",
      actorId: adminProfileId,
    });
    expect(again).toEqual({ result: "SUBMITTED" });
  });

  it("PG 외 환불 반영 2회 제출 → 원장 REFUNDED 1행", async () => {
    const { orderId, amount } = await seedPaid(42000);
    expect(await getRefundableAmount(orderId)).toBe(amount);

    const providerEventId = `manual-refund:${randomUUID()}`;
    const input = {
      provider: "MANUAL" as const,
      providerEventId,
      eventType: "REFUNDED" as const,
      amount,
      currency: "KRW",
      orderId,
      paymentMethod: "BANK_TRANSFER" as const,
      metadata: { reason: "계좌이체" },
      raw: { manual: true },
    };
    const [a, b] = await Promise.all([confirmPayment(input), confirmPayment(input)]);
    expect([a, b].filter((r) => r.recorded)).toHaveLength(1);

    const { data: rows } = await admin
      .from("payment_events")
      .select("id")
      .eq("order_id", orderId)
      .eq("event_type", "REFUNDED")
      .eq("provider_event_id", providerEventId);
    expect(rows ?? []).toHaveLength(1);
    expect(await getRefundableAmount(orderId)).toBe(0);
  });

  it("ADMIN 경로: requestRefund → 웹훅 REFUNDED → 잔액 0", async () => {
    const { orderId, paymentKey, amount } = await seedPaid(43000);
    await requestRefund({
      orderId,
      amount: null,
      reason: "전액",
      requestKey: randomUUID(),
      source: "ADMIN",
      actorId: adminProfileId,
    });
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
    void amount;
    expect(await getRefundableAmount(orderId)).toBe(0);
  });
});
