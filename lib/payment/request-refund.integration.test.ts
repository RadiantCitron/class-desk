import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import {
  confirmPayment,
  requestRefund,
} from "@/lib/payment";
import { UserFacingError } from "@/lib/errors";
import { tossProvider } from "@/lib/payment/providers/toss";
import {
  fakePgEnvOverrides,
  getFakePgOrigin,
  setTossCancelBehavior,
  startFakePg,
  stopFakePg,
} from "@/lib/payment/providers/fake-pg-harness";

/**
 * Code-B 멱등 (a)~(f) + timeout_after_apply — 로컬 Supabase + fake-pg 필요.
 * `npm run test`에서는 제외, `npm run test:integration`으로 실행.
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

const ENV_KEYS = [
  "TOSS_SECRET_KEY",
  "NEXT_PUBLIC_TOSS_CLIENT_KEY",
  "TOSS_API_BASE_URL",
  "NEXT_PUBLIC_TOSS_SDK_URL",
  "PG_CANCEL_TIMEOUT_MS",
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

describe("requestRefund 멱등 — 통합", () => {
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

  async function ensureProfileAndProduct() {
    if (!profileId) {
      const email = `vitest-refund-${randomUUID()}@example.com`;
      const { data: authUser, error: authError } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
      });
      if (authError || !authUser.user) {
        throw new Error(`auth 생성 실패: ${authError?.message}`);
      }
      authUserId = authUser.user.id;
      const { data: profile, error: profileError } = await admin
        .from("users")
        .insert({ auth_user_id: authUserId, email, role: "STUDENT" })
        .select("id")
        .single();
      if (profileError || !profile) {
        throw new Error(`프로필 실패: ${profileError?.message}`);
      }
      profileId = profile.id;
    }
    if (!productId) {
      const { data: product, error: productError } = await admin
        .from("products")
        .insert({ name: `vitest-refund-${randomUUID()}`, price: 50000 })
        .select("id")
        .single();
      if (productError || !product) {
        throw new Error(`상품 실패: ${productError?.message}`);
      }
      productId = product.id;
    }
  }

  async function createPaidOrder(amount: number) {
    await ensureProfileAndProduct();
    const orderId = randomUUID();
    const { error: orderError } = await admin.from("orders").insert({
      id: orderId,
      user_id: profileId!,
      product_id: productId!,
      status: "APPROVED",
      payment_status: "PAID",
      approved_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
      list_price: amount,
      final_amount: amount,
      payment_method: "CARD",
    });
    if (orderError) throw new Error(`주문 실패: ${orderError.message}`);

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
    if (peError) throw new Error(`원장 실패: ${peError.message}`);

    return { orderId, paymentKey, amount };
  }

  async function cancelCount(paymentKey: string) {
    const origin = getFakePgOrigin();
    const auth = `Basic ${Buffer.from(`${process.env.TOSS_SECRET_KEY}:`).toString("base64")}`;
    const res = await fetch(`${origin}/toss/v1/payments/${paymentKey}`, {
      headers: { Authorization: auth },
    });
    const json = (await res.json()) as { cancels?: unknown[] };
    return json.cancels?.length ?? 0;
  }

  async function applyRefundWebhook(paymentKey: string, orderId: string, amount: number) {
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
    // 웹훅이 금액 0인 경우 대비 — GET cancels로 반영 확인 후 MANUAL REFUNDED도 허용하지 않음.
    // fake receiveWebhook이 REFUNDED를 주면 위 경로로 충분.
    void amount;
  }

  it("(a) 같은 requestKey 2회 → PG 1회, 두 번째 ALREADY_IN_PROGRESS", async () => {
    const { orderId, paymentKey } = await createPaidOrder(50000);
    const requestKey = randomUUID();
    const first = await requestRefund({
      orderId,
      amount: null,
      reason: "테스트 a",
      requestKey,
      source: "ADMIN",
      actorId: adminProfileId,
    });
    expect(first).toEqual({ result: "SUBMITTED" });
    const second = await requestRefund({
      orderId,
      amount: null,
      reason: "테스트 a",
      requestKey,
      source: "ADMIN",
      actorId: adminProfileId,
    });
    expect(second).toEqual({ result: "ALREADY_IN_PROGRESS" });
    expect(await cancelCount(paymentKey)).toBe(1);
  });

  it("(b) 다른 key 동시 2회 → PG 1회, 하나는 ALREADY_IN_PROGRESS", async () => {
    const { orderId, paymentKey } = await createPaidOrder(48000);
    const results = await Promise.all([
      requestRefund({
        orderId,
        amount: null,
        reason: "동시1",
        requestKey: randomUUID(),
        source: "ADMIN",
        actorId: adminProfileId,
      }),
      requestRefund({
        orderId,
        amount: null,
        reason: "동시2",
        requestKey: randomUUID(),
        source: "ADMIN",
        actorId: adminProfileId,
      }),
    ]);
    const submitted = results.filter((r) => r.result === "SUBMITTED");
    const inProgress = results.filter((r) => r.result === "ALREADY_IN_PROGRESS");
    expect(submitted).toHaveLength(1);
    expect(inProgress).toHaveLength(1);
    expect(await cancelCount(paymentKey)).toBe(1);
  });

  it("(c) PG 타임아웃(적용 전) → 요청 열림, 재호출 PG 0회", async () => {
    process.env.PG_CANCEL_TIMEOUT_MS = "600";
    Object.assign(process.env, fakePgEnvOverrides());
    const { orderId, paymentKey } = await createPaidOrder(47000);
    await setTossCancelBehavior(paymentKey, "timeout_before_apply");
    await expect(
      requestRefund({
        orderId,
        amount: null,
        reason: "타임아웃",
        requestKey: randomUUID(),
        source: "ADMIN",
        actorId: adminProfileId,
      }),
    ).rejects.toThrow(/다시 누르지 마세요/);
    expect(await cancelCount(paymentKey)).toBe(0);
    const retry = await requestRefund({
      orderId,
      amount: null,
      reason: "재시도",
      requestKey: randomUUID(),
      source: "ADMIN",
      actorId: adminProfileId,
    });
    expect(retry).toEqual({ result: "ALREADY_IN_PROGRESS" });
    expect(await cancelCount(paymentKey)).toBe(0);
  });

  it("(d) PG 거절 → FAILED, 새 키로 재호출 가능", async () => {
    const { orderId, paymentKey } = await createPaidOrder(46000);
    await setTossCancelBehavior(paymentKey, "reject_403");
    await expect(
      requestRefund({
        orderId,
        amount: null,
        reason: "거절",
        requestKey: randomUUID(),
        source: "ADMIN",
        actorId: adminProfileId,
      }),
    ).rejects.toBeInstanceOf(UserFacingError);

    const { data: failed } = await admin
      .from("payment_events")
      .select("id")
      .eq("order_id", orderId)
      .eq("event_type", "REFUND_REQUEST_FAILED")
      .maybeSingle();
    expect(failed).toBeTruthy();

    const again = await requestRefund({
      orderId,
      amount: null,
      reason: "재시도 성공",
      requestKey: randomUUID(),
      source: "ADMIN",
      actorId: adminProfileId,
    });
    expect(again).toEqual({ result: "SUBMITTED" });
    expect(await cancelCount(paymentKey)).toBe(1);
  });

  it("(e) 웹훅 후 잔액 0 → NOTHING_TO_REFUND", async () => {
    const { orderId, paymentKey, amount } = await createPaidOrder(45000);
    const key = randomUUID();
    await requestRefund({
      orderId,
      amount: null,
      reason: "전액",
      requestKey: key,
      source: "ADMIN",
      actorId: adminProfileId,
    });
    await applyRefundWebhook(paymentKey, orderId, amount);
    const again = await requestRefund({
      orderId,
      amount: null,
      reason: "또",
      requestKey: randomUUID(),
      source: "ADMIN",
      actorId: adminProfileId,
    });
    expect(again).toEqual({ result: "NOTHING_TO_REFUND" });
  });

  it("(f) 수동 결제 확정 동시 2회 → 원장 SUCCEEDED 1행(D18)", async () => {
    await ensureProfileAndProduct();
    const orderId = randomUUID();
    const { error: orderError } = await admin.from("orders").insert({
      id: orderId,
      user_id: profileId!,
      product_id: productId!,
      status: "APPROVED",
      payment_status: "UNPAID",
      approved_at: new Date().toISOString(),
      list_price: 33000,
      final_amount: 33000,
    });
    if (orderError) throw new Error(orderError.message);

    const input = {
      provider: "MANUAL" as const,
      providerEventId: `manual-confirm:${orderId}`,
      eventType: "PAYMENT_SUCCEEDED" as const,
      amount: 33000,
      currency: "KRW",
      orderId,
      paymentMethod: "BANK_TRANSFER" as const,
      metadata: { reason: "동시확정" },
      raw: { manual: true },
    };
    const [a, b] = await Promise.all([confirmPayment(input), confirmPayment(input)]);
    const recorded = [a, b].filter((r) => r.recorded);
    expect(recorded).toHaveLength(1);

    const { data: rows } = await admin
      .from("payment_events")
      .select("id")
      .eq("order_id", orderId)
      .eq("event_type", "PAYMENT_SUCCEEDED");
    expect(rows ?? []).toHaveLength(1);
  });

  it("MANUAL 결제에 PG 환불을 요청하면 PG 호출 없이 실패 기록된다(F7)", async () => {
    await ensureProfileAndProduct();
    const orderId = randomUUID();
    const { error: orderError } = await admin.from("orders").insert({
      id: orderId,
      user_id: profileId!,
      product_id: productId!,
      status: "APPROVED",
      payment_status: "PAID",
      approved_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
      list_price: 27000,
      final_amount: 27000,
      payment_method: "BANK_TRANSFER",
    });
    if (orderError) throw new Error(`주문 실패: ${orderError.message}`);
    const { error: peError } = await admin.from("payment_events").insert({
      provider: "MANUAL",
      provider_event_id: `manual-confirm:${orderId}`,
      event_type: "PAYMENT_SUCCEEDED",
      amount: 27000,
      currency: "KRW",
      order_id: orderId,
      payment_method: "BANK_TRANSFER",
    });
    if (peError) throw new Error(`원장 실패: ${peError.message}`);

    await expect(
      requestRefund({
        orderId,
        amount: null,
        reason: "MANUAL 결제 PG 환불 시도",
        requestKey: randomUUID(),
        source: "ADMIN",
        actorId: adminProfileId,
      }),
    ).rejects.toThrow(/PG 외 환불 반영/);

    const { data: rows } = await admin
      .from("payment_events")
      .select("event_type")
      .eq("order_id", orderId)
      .in("event_type", ["REFUND_REQUESTED", "REFUND_REQUEST_FAILED"]);
    const types = (rows ?? []).map((r) => r.event_type).sort();
    expect(types).toEqual(["REFUND_REQUESTED", "REFUND_REQUEST_FAILED"]);
  });

  it("timeout_after_apply: PG는 취소·웹훅, 파사드는 열림 유지 → 웹훅 후 재호출 PG 0회", async () => {
    process.env.PG_CANCEL_TIMEOUT_MS = "600";
    Object.assign(process.env, fakePgEnvOverrides());
    const { orderId, paymentKey, amount } = await createPaidOrder(44000);
    await setTossCancelBehavior(paymentKey, "timeout_after_apply");
    await expect(
      requestRefund({
        orderId,
        amount: null,
        reason: "적용후타임아웃",
        requestKey: randomUUID(),
        source: "ADMIN",
        actorId: adminProfileId,
      }),
    ).rejects.toThrow(/다시 누르지 마세요/);
    expect(await cancelCount(paymentKey)).toBe(1);

    // 요청은 아직 열림
    const mid = await requestRefund({
      orderId,
      amount: null,
      reason: "재시도금지",
      requestKey: randomUUID(),
      source: "ADMIN",
      actorId: adminProfileId,
    });
    expect(mid).toEqual({ result: "ALREADY_IN_PROGRESS" });
    expect(await cancelCount(paymentKey)).toBe(1);

    await applyRefundWebhook(paymentKey, orderId, amount);

    const after = await requestRefund({
      orderId,
      amount: null,
      reason: "잔액없음",
      requestKey: randomUUID(),
      source: "ADMIN",
      actorId: adminProfileId,
    });
    expect(after).toEqual({ result: "NOTHING_TO_REFUND" });
    expect(await cancelCount(paymentKey)).toBe(1);
  });
});
