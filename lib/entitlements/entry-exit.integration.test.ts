import { describe, it, expect, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

// 이 파일은 통합 테스트다 — 실제 로컬 Supabase가 떠 있어야 한다(`npm run db:start`). [로컬] 전용.
// 권한의 입구(grant_entitlements_for_order)·출구(revoke_entitlements)가
// "하나의 함수, 여러 길"인지 DB 함수를 직접 불러 확인한다: 부여 근거 2종(PAYMENT·ADMIN_GRANT)과 회수 사유 4종.
// (핸들러·아웃박스 경유 동작은 lib/outbox/drain.integration.test.ts가 이어서 본다.)

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다. .env.local을 확인하고 " +
      "`npm run db:start`로 로컬 Supabase를 띄운 뒤 다시 실행하세요.",
  );
}

const admin = createClient(url, key, { auth: { persistSession: false } });

describe("이용권 입구·출구 일반화 — 통합 테스트(로컬 Supabase 필요)", { timeout: 60_000 }, () => {
  let authUserId: string | null = null;
  let profileId: string | null = null;
  let orderId: string | null = null;
  let entitlementIds: string[] = [];

  afterEach(async () => {
    // F-6 불변 트리거로 인해 이용권 DELETE는 거부됨 — 주문·원장과 마찬가지로 잔여는 db:reset.
    entitlementIds = [];
    if (profileId) {
      await admin.from("users").update({ withdrawn_at: new Date().toISOString() }).eq("id", profileId);
      profileId = null;
    }
    if (authUserId) {
      await admin.auth.admin.deleteUser(authUserId);
      authUserId = null;
    }
    orderId = null;
  });

  async function createFixture() {
    const email = `vitest-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (authError || !authUser.user) throw new Error(`테스트 계정 생성 실패: ${authError?.message}`);
    authUserId = authUser.user.id;

    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({ auth_user_id: authUserId, email, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(`프로필 생성 실패: ${profileError?.message}`);
    profileId = profile.id as string;

    const { data: product, error: productError } = await admin
      .from("products")
      .insert({ name: `vitest-${randomUUID()}`, price: 1000 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`상품 픽스처 생성 실패: ${productError?.message}`);

    const { data: order, error: orderError } = await admin
      .from("orders")
      .insert({ user_id: profileId, product_id: product.id, status: "APPROVED", approved_at: new Date().toISOString() })
      .select("id")
      .single();
    if (orderError || !order) throw new Error(`주문 픽스처 생성 실패: ${orderError?.message}`);
    orderId = order.id as string;

    const { data: paymentEvent, error: paymentEventError } = await admin
      .from("payment_events")
      .insert({
        order_id: orderId,
        event_type: "PAYMENT_SUCCEEDED",
        amount: 1000,
        provider: "MOCK",
        provider_event_id: `vitest-${randomUUID()}`,
      })
      .select("id")
      .single();
    if (paymentEventError || !paymentEvent) throw new Error(`결제 원장 픽스처 생성 실패: ${paymentEventError?.message}`);

    // 직권 부여의 근거 행 — E-2 전이라 ACCESS_GRANTED 종류가 아직 없어 기존 종류(APPROVED, ADMIN)로 대신한다.
    const { data: orderEvent, error: orderEventError } = await admin
      .from("order_events")
      .insert({ order_id: orderId, event_type: "APPROVED", actor: "ADMIN", payload: { vitest: true } })
      .select("id")
      .single();
    if (orderEventError || !orderEvent) throw new Error(`주문 이벤트 픽스처 생성 실패: ${orderEventError?.message}`);

    return {
      userId: profileId,
      orderId,
      paymentEventId: paymentEvent.id as string,
      orderEventId: orderEvent.id as string,
    };
  }

  async function grant(p: {
    orderId: string;
    userId: string;
    source: string | null;
    sourceId: string | null;
    grants?: unknown;
  }) {
    const result = await admin.rpc("grant_entitlements_for_order", {
      p_order_id: p.orderId,
      p_user_id: p.userId,
      p_source: p.source,
      p_source_id: p.sourceId,
      p_grants: p.grants ?? null,
    });
    const rows = (result.data ?? []) as Array<{
      id: string;
      type: string;
      grant_source: string;
      payment_event_id: string | null;
      grant_event_id: string | null;
    }>;
    entitlementIds.push(...rows.map((r) => r.id));
    return { rows, error: result.error };
  }

  it("입구 — 결제(PAYMENT) 근거: 기본 COURSE_ACCESS 1건, 같은 결제로 다시 불러도 한 벌", async () => {
    const f = await createFixture();

    const first = await grant({ orderId: f.orderId, userId: f.userId, source: "PAYMENT", sourceId: f.paymentEventId });
    expect(first.error).toBeNull();
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({
      type: "COURSE_ACCESS",
      grant_source: "PAYMENT",
      payment_event_id: f.paymentEventId,
      grant_event_id: null,
    });

    const again = await grant({ orderId: f.orderId, userId: f.userId, source: "PAYMENT", sourceId: f.paymentEventId });
    expect(again.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));

    const { count } = await admin
      .from("entitlements")
      .select("id", { count: "exact", head: true })
      .eq("payment_event_id", f.paymentEventId);
    expect(count).toBe(1);
  });

  it("입구 — 직권(ADMIN_GRANT) 근거: 결제 원장 없이 부여되고(payment_event_id 비어 있음), 같은 근거로 다시 불러도 한 벌", async () => {
    const f = await createFixture();
    const grants = [{ type: "COURSE_ACCESS" }, { type: "DISCORD_ROLE", discord_role_id: "123456789" }];

    const first = await grant({ orderId: f.orderId, userId: f.userId, source: "ADMIN_GRANT", sourceId: f.orderEventId, grants });
    expect(first.error).toBeNull();
    expect(first.rows).toHaveLength(2);
    for (const row of first.rows) {
      expect(row).toMatchObject({ grant_source: "ADMIN_GRANT", payment_event_id: null, grant_event_id: f.orderEventId });
    }

    const again = await grant({ orderId: f.orderId, userId: f.userId, source: "ADMIN_GRANT", sourceId: f.orderEventId, grants });
    expect(again.rows.map((r) => r.id).sort()).toEqual(first.rows.map((r) => r.id).sort());

    const { count } = await admin
      .from("entitlements")
      .select("id", { count: "exact", head: true })
      .eq("grant_event_id", f.orderEventId);
    expect(count).toBe(2);
  });

  it("입구 — 알 수 없는 근거 종류·근거 id 없음은 거부된다", async () => {
    const f = await createFixture();

    const unknown = await grant({ orderId: f.orderId, userId: f.userId, source: "COUPON", sourceId: f.orderEventId });
    expect(unknown.error?.message).toContain("알 수 없는 부여 근거");

    const noSource = await grant({ orderId: f.orderId, userId: f.userId, source: null, sourceId: f.orderEventId });
    expect(noSource.error?.message).toContain("알 수 없는 부여 근거");

    const noId = await grant({ orderId: f.orderId, userId: f.userId, source: "ADMIN_GRANT", sourceId: null });
    expect(noId.error?.message).toContain("부여 근거 id가 없습니다");

    const { count } = await admin.from("entitlements").select("id", { count: "exact", head: true }).eq("order_id", f.orderId);
    expect(count).toBe(0);
  });

  it("DB 제약 — 근거 종류와 근거 칼럼이 어긋난 행은 함수를 우회해도 저장되지 않는다", async () => {
    const f = await createFixture();
    const base = { user_id: f.userId, type: "COURSE_ACCESS", order_id: f.orderId };

    // ADMIN_GRANT인데 결제 원장 id가 채워짐
    const a = await admin
      .from("entitlements")
      .insert({ ...base, access_code: `VT${randomUUID().slice(0, 14)}`, grant_source: "ADMIN_GRANT", payment_event_id: f.paymentEventId })
      .select("id");
    expect(a.error?.message).toContain("entitlements_grant_source_pair");

    // PAYMENT인데 직권 근거만 있음
    const b = await admin
      .from("entitlements")
      .insert({ ...base, access_code: `VT${randomUUID().slice(0, 14)}`, grant_source: "PAYMENT", grant_event_id: f.orderEventId })
      .select("id");
    expect(b.error?.message).toContain("entitlements_grant_source_pair");

    // 근거 종류 값 자체가 목록 밖
    const c = await admin
      .from("entitlements")
      .insert({ ...base, access_code: `VT${randomUUID().slice(0, 14)}`, grant_source: "COUPON", payment_event_id: f.paymentEventId })
      .select("id");
    expect(c.error?.message).toContain("entitlements_grant_source_check");
  });

  it("출구 — 회수 사유 4종(REFUNDED·WITHDRAWN·COURSE_ENDED·ADMIN_CLOSED)이 그대로 기록되고, 다른 사유는 거부된다", async () => {
    const f = await createFixture();

    for (const reason of ["REFUNDED", "WITHDRAWN", "COURSE_ENDED", "ADMIN_CLOSED"] as const) {
      // 사유마다 새 근거(직권 부여 이벤트)로 이용권을 만들고 그 주문만 회수한다.
      const { data: ev, error: evError } = await admin
        .from("order_events")
        .insert({ order_id: f.orderId, event_type: "APPROVED", actor: "ADMIN", payload: { vitest: reason } })
        .select("id")
        .single();
      if (evError || !ev) throw new Error(`주문 이벤트 생성 실패: ${evError?.message}`);
      const granted = await grant({ orderId: f.orderId, userId: f.userId, source: "ADMIN_GRANT", sourceId: ev.id as string });
      expect(granted.rows).toHaveLength(1);

      const revoked = await admin.rpc("revoke_entitlements", { p_user_id: f.userId, p_order_id: f.orderId, p_reason: reason });
      expect(revoked.error).toBeNull();

      const { data: row } = await admin
        .from("entitlements")
        .select("revoked_at, revoked_reason")
        .eq("id", granted.rows[0].id)
        .single();
      expect(row?.revoked_reason).toBe(reason);
      expect(row?.revoked_at).not.toBeNull();
    }

    const bad = await admin.rpc("revoke_entitlements", { p_user_id: f.userId, p_order_id: f.orderId, p_reason: "EXPIRED" });
    expect(bad.error?.message).toContain("알 수 없는 회수 사유");
  });
});
