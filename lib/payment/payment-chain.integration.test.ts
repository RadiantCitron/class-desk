import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import {
  completeCheckout,
  ingestWebhook,
  requestRefund,
  startCheckout,
} from "@/lib/payment";
import { runOutboxBatch } from "@/lib/wiring/outbox";
import {
  fakePgEnvOverrides,
  getFakePgOrigin,
  startFakePg,
  stopFakePg,
} from "@/lib/payment/providers/fake-pg-harness";

/**
 * G1 작업 3 — 결제 사슬(파사드 입구) 통합.
 * 로컬 Supabase + 가짜 PG. `npm run test:integration` / 직접 vitest run.
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
  "APP_BASE_URL",
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

type Actor = { profileId: string; authUserId: string; email: string };

// 부분 환불 시나리오(C2)는 outbox 배치를 여러 번 돌려 약 24초 걸린다(기본 20초 초과) — 이 파일만 60초.
describe("결제 사슬(payment-chain) — 통합", { timeout: 60_000 }, () => {
  let originalProvider: string | null = null;
  let student: Actor | null = null;
  let adminActor: Actor | null = null;
  let productId: string | null = null;
  let orderId: string | null = null;
  let t0: Date = new Date();

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    await startFakePg();
    Object.assign(process.env, fakePgEnvOverrides());
    if (!process.env.APP_BASE_URL) {
      process.env.APP_BASE_URL = "http://127.0.0.1:3000";
    }

    const { data: settings, error: settingsError } = await admin
      .from("payment_settings")
      .select("active_provider")
      .eq("id", "SINGLETON")
      .single();
    if (settingsError) throw new Error(`payment_settings 읽기 실패: ${settingsError.message}`);
    originalProvider = settings?.active_provider ?? null;
  });

  afterAll(async () => {
    // afterEach가 관리자를 지우므로, 복원용 임시 액터를 만들어 RPC로 되돌린다.
    try {
      const restorer = await createActor("ADMIN");
      const { error } = await admin.rpc("set_payment_provider", {
        p_active_provider: originalProvider,
        p_reason: "vitest payment-chain restore",
        p_actor_id: restorer.profileId,
      });
      if (error) throw new Error(error.message);
      await admin
        .from("users")
        .update({ withdrawn_at: new Date().toISOString() })
        .eq("id", restorer.profileId);
      await admin.auth.admin.deleteUser(restorer.authUserId);
    } catch (err) {
      console.error("payment_settings 복원 실패:", err);
    }
    stopFakePg();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  afterEach(async () => {
    const oid = orderId;
    if (oid) {
      const { error: outboxErr } = await admin
        .from("outbox_messages")
        .delete()
        .contains("payload", { order_id: oid });
      if (outboxErr) throw new Error(`outbox 정리 실패: ${outboxErr.message}`);

      // F-6: entitlements 불변 트리거로 인해 DELETE 불가 — 잔여는 db:reset.
      // payment_events·orders·products는 삭제하지 않는다 — append-only 트리거가 service_role
      // DELETE를 막고, FK restrict로 주문·상품도 연쇄 삭제 불가. 기존 통합 테스트와 같이 잔여를 남긴다.

      const { data: dlqRows, error: dlqSelErr } = await admin
        .from("dead_letters")
        .select("id, error_message, payload")
        .gte("created_at", t0.toISOString());
      if (dlqSelErr) throw new Error(`dead_letters 조회 실패: ${dlqSelErr.message}`);
      const dlqIds = (dlqRows ?? [])
        .filter((r) => dlqMatchesOrder(r, oid))
        .map((r) => r.id as string);
      if (dlqIds.length > 0) {
        const { error: dlqDelErr } = await admin.from("dead_letters").delete().in("id", dlqIds);
        if (dlqDelErr) throw new Error(`dead_letters 정리 실패: ${dlqDelErr.message}`);
      }
    }
    orderId = null;
    productId = null; // DB 행은 남김(위 주석). 참조만 해제.

    for (const actor of [student, adminActor]) {
      if (!actor) continue;
      const { error: wErr } = await admin
        .from("users")
        .update({ withdrawn_at: new Date().toISOString() })
        .eq("id", actor.profileId);
      if (wErr) throw new Error(`users withdrawn 실패: ${wErr.message}`);
      const { error: aErr } = await admin.auth.admin.deleteUser(actor.authUserId);
      if (aErr) throw new Error(`auth 삭제 실패: ${aErr.message}`);
    }
    student = null;
    adminActor = null;
  });

  function dlqMatchesOrder(
    row: { error_message?: string | null; payload?: unknown },
    oid: string,
  ): boolean {
    if (typeof row.error_message === "string" && row.error_message.includes(oid)) return true;
    const payload = row.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const orderIdInPayload = (payload as Record<string, unknown>).order_id;
      if (orderIdInPayload === oid) return true;
    }
    return false;
  }

  async function expectNoNewDlq(oid: string, since: Date) {
    const { data, error } = await admin
      .from("dead_letters")
      .select("id, error_message, payload, created_at")
      .gte("created_at", since.toISOString());
    if (error) throw new Error(`DLQ 조회 실패: ${error.message}`);
    const hits = (data ?? []).filter((r) => dlqMatchesOrder(r, oid));
    expect(hits, `새 DLQ ${hits.length}건: ${JSON.stringify(hits)}`).toHaveLength(0);
  }

  async function countEvents(oid: string, eventType: string) {
    const { data, error } = await admin
      .from("payment_events")
      .select("id")
      .eq("order_id", oid)
      .eq("event_type", eventType);
    if (error) throw new Error(error.message);
    return data?.length ?? 0;
  }

  async function activeEntitlementCount(oid: string) {
    const { data, error } = await admin
      .from("entitlements")
      .select("id, revoked_at")
      .eq("order_id", oid);
    if (error) throw new Error(error.message);
    return (data ?? []).filter((e) => e.revoked_at == null).length;
  }

  function promoteToAdminViaSql(email: string) {
    // users_guard_admin_role이 service_role ADMIN INSERT를 막음 — e2e/helpers와 동일 경로.
    execFileSync("docker", [
      "exec",
      "supabase_db_class-desk",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      `update public.users set role = 'ADMIN' where email = '${email}';`,
    ]);
  }

  async function createActor(role: "STUDENT" | "ADMIN"): Promise<Actor> {
    const email = `vitest-chain-${role.toLowerCase()}-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (authError || !authUser.user) {
      throw new Error(`auth 생성 실패: ${authError?.message}`);
    }
    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({ auth_user_id: authUser.user.id, email, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) {
      throw new Error(`프로필 실패: ${profileError?.message}`);
    }
    if (role === "ADMIN") promoteToAdminViaSql(email);
    return { profileId: profile.id, authUserId: authUser.user.id, email };
  }

  async function setProvider(provider: "TOSS") {
    if (!adminActor) throw new Error("adminActor 없음");
    const { error } = await admin.rpc("set_payment_provider", {
      p_active_provider: provider,
      p_reason: "vitest payment-chain",
      p_actor_id: adminActor.profileId,
    });
    if (error) throw new Error(`set_payment_provider 실패: ${error.message}`);
  }

  async function seedUnpaidOrder(amount: number) {
    t0 = new Date();
    student = await createActor("STUDENT");
    adminActor = await createActor("ADMIN");

    const { data: product, error: productError } = await admin
      .from("products")
      .insert({ name: `vitest-chain-${randomUUID()}`, price: amount })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`상품 실패: ${productError?.message}`);
    productId = product.id;

    const id = randomUUID();
    const { error: orderError } = await admin.from("orders").insert({
      id,
      user_id: student.profileId,
      product_id: productId,
      status: "APPROVED",
      payment_status: "UNPAID",
      approved_at: new Date().toISOString(),
      list_price: amount,
      final_amount: amount,
    });
    if (orderError) throw new Error(`주문 실패: ${orderError.message}`);
    orderId = id;
    return { orderId: id, amount };
  }

  async function tossPayThrough(amount: number) {
    Object.assign(process.env, fakePgEnvOverrides());
    if (!process.env.APP_BASE_URL) process.env.APP_BASE_URL = "http://127.0.0.1:3000";
    await setProvider("TOSS");

    const { clientParams } = await startCheckout({
      orderId: orderId!,
      amount,
      buyerName: "테스트",
    });
    const tossOrderId = clientParams?.tossOrderId;
    const successUrl = clientParams?.successUrl;
    const failUrl = clientParams?.failUrl;
    if (!tossOrderId || !successUrl || !failUrl) {
      throw new Error(`SDK 호출 값 부족: ${JSON.stringify(clientParams)}`);
    }

    const origin = getFakePgOrigin();
    const body = new URLSearchParams({
      orderId: tossOrderId,
      amount: String(amount),
      successUrl,
      failUrl,
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
    const returnOrderId = u.searchParams.get("orderId")!;
    const returnAmount = u.searchParams.get("amount")!;

    const done = await completeCheckout(
      "TOSS",
      { paymentKey, orderId: returnOrderId, amount: returnAmount },
      amount,
      orderId!,
      new URL(successUrl).searchParams.get("attempt"),
    );
    expect(done).toEqual({ status: "SUCCEEDED" });
    await runOutboxBatch();
    return { paymentKey };
  }

  it("C1. 토스 — 결제 → 앱 전액 환불 → 웹훅", async () => {
    const amount = 30000;
    const { orderId: oid } = await seedUnpaidOrder(amount);
    const { paymentKey } = await tossPayThrough(amount);

    const { data: paidOrder } = await admin
      .from("orders")
      .select("payment_status")
      .eq("id", oid)
      .single();
    expect(paidOrder?.payment_status).toBe("PAID");
    expect(await activeEntitlementCount(oid)).toBe(1);

    const refund = await requestRefund({
      orderId: oid,
      amount: null,
      reason: "chain C1",
      requestKey: randomUUID(),
      source: "ADMIN",
      actorId: adminActor?.profileId,
    });
    expect(refund).toEqual({ result: "SUBMITTED" });

    const wh = await ingestWebhook(
      "TOSS",
      JSON.stringify({
        eventType: "PAYMENT_STATUS_CHANGED",
        data: { paymentKey, status: "CANCELED" },
      }),
      new Headers(),
    );
    expect(wh.failures).toEqual([]);
    await runOutboxBatch();
    await runOutboxBatch();

    expect(await countEvents(oid, "PAYMENT_INITIATED")).toBe(0); // 시도는 원장이 아니라 payment_attempts에 남는다
    const { count: attemptCount } = await admin
      .from("payment_attempts")
      .select("id", { count: "exact", head: true })
      .eq("order_id", oid);
    expect(attemptCount).toBe(1);
    expect(await countEvents(oid, "PAYMENT_SUCCEEDED")).toBe(1);
    expect(await countEvents(oid, "REFUND_REQUESTED")).toBe(1);
    expect(await countEvents(oid, "REFUNDED")).toBe(1);

    const { data: order } = await admin
      .from("orders")
      .select("status, payment_status, refunded_amount")
      .eq("id", oid)
      .single();
    expect(order).toMatchObject({
      status: "CANCELLED",
      payment_status: "REFUNDED",
      refunded_amount: amount,
    });

    const { data: ents } = await admin
      .from("entitlements")
      .select("revoked_at")
      .eq("order_id", oid);
    expect(ents?.length).toBe(1);
    expect(ents![0]!.revoked_at).not.toBeNull();
    expect(await activeEntitlementCount(oid)).toBe(0);
    await expectNoNewDlq(oid, t0);
  });

  it("C2. 토스 — 부분 환불 → 잔여 환불", async () => {
    const amount = 30000;
    const half = amount / 2;
    const { orderId: oid } = await seedUnpaidOrder(amount);
    const { paymentKey } = await tossPayThrough(amount);
    expect(await activeEntitlementCount(oid)).toBe(1);

    expect(
      await requestRefund({
        orderId: oid,
        amount: half,
        reason: "chain C2 partial",
        requestKey: randomUUID(),
        source: "ADMIN",
        actorId: adminActor?.profileId,
      }),
    ).toEqual({ result: "SUBMITTED" });

    const wh1 = await ingestWebhook(
      "TOSS",
      JSON.stringify({
        eventType: "PAYMENT_STATUS_CHANGED",
        data: { paymentKey, status: "PARTIAL_CANCELED" },
      }),
      new Headers(),
    );
    expect(wh1.failures).toEqual([]);
    await runOutboxBatch();
    await runOutboxBatch();

    const { data: partial } = await admin
      .from("orders")
      .select("status, payment_status, refunded_amount")
      .eq("id", oid)
      .single();
    // 부분 환불도 수강 포기다 — 주문이 끝나고 이용권이 회수된다.
    expect(partial).toMatchObject({
      status: "CANCELLED",
      payment_status: "PARTIALLY_REFUNDED",
      refunded_amount: half,
    });
    expect(await activeEntitlementCount(oid)).toBe(0);

    expect(
      await requestRefund({
        orderId: oid,
        amount: null,
        reason: "chain C2 rest",
        requestKey: randomUUID(),
        source: "ADMIN",
        actorId: adminActor?.profileId,
      }),
    ).toEqual({ result: "SUBMITTED" });

    const wh2 = await ingestWebhook(
      "TOSS",
      JSON.stringify({
        eventType: "PAYMENT_STATUS_CHANGED",
        data: { paymentKey, status: "CANCELED" },
      }),
      new Headers(),
    );
    expect(wh2.failures).toEqual([]);
    await runOutboxBatch();
    await runOutboxBatch();

    const { data: full } = await admin
      .from("orders")
      .select("payment_status")
      .eq("id", oid)
      .single();
    expect(full?.payment_status).toBe("REFUNDED");
    expect(await activeEntitlementCount(oid)).toBe(0);

    expect(await countEvents(oid, "PAYMENT_SUCCEEDED")).toBe(1);
    expect(await countEvents(oid, "REFUND_REQUESTED")).toBe(2);
    expect(await countEvents(oid, "REFUNDED")).toBe(2);
    await expectNoNewDlq(oid, t0);
  });
});
