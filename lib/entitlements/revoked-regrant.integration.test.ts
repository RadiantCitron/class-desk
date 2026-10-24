import { describe, it, expect, afterEach, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { setDiscordRoleClientForTest } from "@/lib/discord/bot";
import {
  grantForPaidOrder,
  grantForAdminGrantedOrder,
  revokeForRefundedOrder,
  revokeForClosedOrder,
  revokeForEndedCourse,
} from "./handlers";

// [로컬] 전용 — F-1(ADR-0019/ADR-0029) 이용권 부여 정합성:
// 회수된 이용권을 늦게 도는 부여 재시도가 다시 살려내지 못하게 한다.
// 회수 후 재시도 시 디스코드 grantRole이 호출되지 않고, 회수 상태가 유지되는지 검증.
// 주의: afterEach에서 entitlements 행을 DELETE하지 않는다(F-6 불변 트리거 대비).

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다. .env.local을 확인하고 " +
      "`npm run db:start`로 로컬 Supabase를 띄운 뒤 다시 실행하세요.",
  );
}

const admin = createClient(url, key, { auth: { persistSession: false } });

describe("F-1 이용권 부여 정합성(회수 후 재부여 방지) — 통합 테스트", { timeout: 60_000 }, () => {
  let authUserId: string | null = null;
  let profileId: string | null = null;
  let orderId: string | null = null;

  afterEach(async () => {
    setDiscordRoleClientForTest(null);
    if (profileId) {
      // discord_accounts 정리
      await admin.from("discord_accounts").delete().eq("user_id", profileId);
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
    const email = `vitest-f1-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (authError || !authUser.user) throw new Error(`auth 생성 실패: ${authError?.message}`);
    authUserId = authUser.user.id;

    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({ auth_user_id: authUserId, email, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(`프로필 생성 실패: ${profileError?.message}`);
    profileId = profile.id;

    const { data: product, error: productError } = await admin
      .from("products")
      .insert({ name: `vitest-f1-${randomUUID()}`, price: 10000 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`상품 생성 실패: ${productError?.message}`);

    const { data: order, error: orderError } = await admin
      .from("orders")
      .insert({ user_id: profileId, product_id: product.id, status: "APPROVED", approved_at: new Date().toISOString() })
      .select("id")
      .single();
    if (orderError || !order) throw new Error(`주문 생성 실패: ${orderError?.message}`);
    orderId = order.id;

    const { data: paymentEvent, error: paymentEventError } = await admin
      .from("payment_events")
      .insert({
        order_id: orderId,
        event_type: "PAYMENT_SUCCEEDED",
        amount: 10000,
        provider: "MOCK",
        provider_event_id: `vitest-f1-${randomUUID()}`,
      })
      .select("id")
      .single();
    if (paymentEventError || !paymentEvent) throw new Error(`결제 이벤트 생성 실패: ${paymentEventError?.message}`);

    return {
      userId: profileId,
      orderId,
      paymentEventId: paymentEvent.id,
    };
  }

  it("미연결 결제 → 부여 실패(throw) → 환불 회수 → 디스코드 연결 → 같은 ORDER_PAID 재처리 시 디스코드 역할 부여 호출이 0회여야 한다", async () => {
    const { userId, orderId, paymentEventId } = await createFixture();
    const discordRoleId = `role-${randomUUID()}`;
    const grants = [
      { type: "COURSE_ACCESS" as const },
      { type: "DISCORD_ROLE" as const, discord_role_id: discordRoleId },
    ];

    const mockGrantRole = vi.fn().mockResolvedValue(undefined);
    const mockRevokeRole = vi.fn().mockResolvedValue(undefined);
    setDiscordRoleClientForTest({
      grantRole: mockGrantRole,
      revokeRole: mockRevokeRole,
    });

    // 1. 디스코드 미연결 상태에서 첫 부여 시도: DB 행은 생기지만 디스코드 미연결로 에러 throw
    await expect(
      grantForPaidOrder({
        order_id: orderId,
        user_id: userId,
        payment_event_id: paymentEventId,
        grants,
      }),
    ).rejects.toThrow("디스코드 미연결");

    // entitlements 행은 생성되었음을 확인
    const { data: entBefore } = await admin
      .from("entitlements")
      .select("id, revoked_at")
      .eq("payment_event_id", paymentEventId);
    expect(entBefore).toHaveLength(2);
    expect(entBefore?.every((e) => e.revoked_at === null)).toBe(true);

    // 2. 환불로 회수 실행
    await revokeForRefundedOrder({
      user_id: userId,
      order_id: orderId,
      reason: "REFUNDED",
    });

    // 회수 확인
    const { data: entRevoked } = await admin
      .from("entitlements")
      .select("id, revoked_at, revoked_reason")
      .eq("payment_event_id", paymentEventId);
    expect(entRevoked).toHaveLength(2);
    expect(entRevoked?.every((e) => e.revoked_at !== null)).toBe(true);
    expect(entRevoked?.every((e) => e.revoked_reason === "REFUNDED")).toBe(true);

    // 3. 학생이 이제 디스코드를 연결함
    const discordUserId = `discord-${randomUUID()}`;
    const { error: linkErr } = await admin.from("discord_accounts").insert({
      user_id: userId,
      discord_id: discordUserId,
    });
    if (linkErr) throw new Error(`디스코드 연결 실패: ${linkErr.message}`);

    // 4. 아웃박스에서 같은 ORDER_PAID 재시도가 돎
    mockGrantRole.mockClear();
    await grantForPaidOrder({
      order_id: orderId,
      user_id: userId,
      payment_event_id: paymentEventId,
      grants,
    });

    // F-1 핵심 검증: 이미 회수된 행이므로 반환되지 않고, 디스코드에 역할을 주지 않아야 함!
    expect(mockGrantRole).not.toHaveBeenCalled();

    // DB의 entitlements도 계속 회수 상태여야 함
    const { data: entAfter } = await admin
      .from("entitlements")
      .select("id, revoked_at")
      .eq("payment_event_id", paymentEventId);
    expect(entAfter).toHaveLength(2);
    expect(entAfter?.every((e) => e.revoked_at !== null)).toBe(true);
  });

  it("회수 사유가 COURSE_ENDED / ADMIN_CLOSED인 경우에도 같은 ORDER_PAID 재처리 시 디스코드 역할이 부여되지 않는다", async () => {
    const { userId, orderId, paymentEventId } = await createFixture();
    const discordRoleId = `role-${randomUUID()}`;
    const grants = [{ type: "DISCORD_ROLE" as const, discord_role_id: discordRoleId }];

    const mockGrantRole = vi.fn().mockResolvedValue(undefined);
    setDiscordRoleClientForTest({
      grantRole: mockGrantRole,
      revokeRole: vi.fn().mockResolvedValue(undefined),
    });

    // 첫 시도 (미연결 throw)
    await expect(
      grantForPaidOrder({
        order_id: orderId,
        user_id: userId,
        payment_event_id: paymentEventId,
        grants,
      }),
    ).rejects.toThrow("디스코드 미연결");

    // 회수: ADMIN_CLOSED
    await revokeForClosedOrder({
      user_id: userId,
      order_id: orderId,
      reason: "ADMIN_CLOSED",
    });

    // 디스코드 연결
    const { error: linkErr } = await admin.from("discord_accounts").insert({
      user_id: userId,
      discord_id: `discord-${randomUUID()}`,
    });
    if (linkErr) throw new Error(`디스코드 연결 실패: ${linkErr.message}`);

    // 재처리
    mockGrantRole.mockClear();
    await grantForPaidOrder({
      order_id: orderId,
      user_id: userId,
      payment_event_id: paymentEventId,
      grants,
    });

    expect(mockGrantRole).not.toHaveBeenCalled();
  });

  it("정상 경로: 디스코드 연결된 상태에서는 정상 부여되고(1회), 멱등 재호출 시 역할 부여가 재시도될 수 있다", async () => {
    const { userId, orderId, paymentEventId } = await createFixture();
    const discordRoleId = `role-${randomUUID()}`;
    const discordUserId = `discord-${randomUUID()}`;
    const grants = [{ type: "DISCORD_ROLE" as const, discord_role_id: discordRoleId }];

    const { error: linkErr } = await admin.from("discord_accounts").insert({
      user_id: userId,
      discord_id: discordUserId,
    });
    if (linkErr) throw new Error(`디스코드 연결 실패: ${linkErr.message}`);

    const mockGrantRole = vi.fn().mockResolvedValue(undefined);
    setDiscordRoleClientForTest({
      grantRole: mockGrantRole,
      revokeRole: vi.fn().mockResolvedValue(undefined),
    });

    // 정상 첫 부여
    await grantForPaidOrder({
      order_id: orderId,
      user_id: userId,
      payment_event_id: paymentEventId,
      grants,
    });

    expect(mockGrantRole).toHaveBeenCalledTimes(1);
    expect(mockGrantRole).toHaveBeenCalledWith(discordUserId, discordRoleId);

    // 회수 없이 같은 메시지 재처리: 행 중복 없이 정상 처리
    mockGrantRole.mockClear();
    await grantForPaidOrder({
      order_id: orderId,
      user_id: userId,
      payment_event_id: paymentEventId,
      grants,
    });

    expect(mockGrantRole).toHaveBeenCalledTimes(1);
    const { data: entRows } = await admin
      .from("entitlements")
      .select("id")
      .eq("payment_event_id", paymentEventId);
    expect(entRows).toHaveLength(1);
  });
});
