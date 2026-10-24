import { describe, it, expect, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { runOutboxBatch } from "@/lib/wiring/outbox";
import { checkSystemIntegrity } from "@/lib/integrity/checks";
import { setDiscordRoleClientForTest } from "@/lib/discord/bot";
import { createMockDiscordRoleClient } from "@/lib/discord/mock-role-client";

// 이 파일은 통합 테스트다 — 실제 로컬 Supabase가 떠 있어야 한다(`npm run db:start`). [로컬] 전용.
// 직권 수강 부여: DB 함수 grant_order_access()가 남긴 사실(ORDER_ACCESS_GRANTED)이
// 아웃박스를 거쳐 이용권 모듈에 닿아 E-1의 입구(p_source = 'ADMIN_GRANT')로 부여되고, 같은 길로 회수되는지,
// 이용권이 안 생기면 대사가 잡는지 본다. (DB 함수 자체의 검증·거부는 supabase/tests/integrity_check.sql TEST92.)

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다. .env.local을 확인하고 " +
      "`npm run db:start`로 로컬 Supabase를 띄운 뒤 다시 실행하세요.",
  );
}

const admin = createClient(url, key, { auth: { persistSession: false } });

type Profile = { id: string; authUserId: string };

describe("직권 수강 부여 — 통합 테스트(로컬 Supabase 필요)", { timeout: 60_000 }, () => {
  let profiles: Profile[] = [];
  let orderIds: string[] = [];
  let extraOutboxMessageIds: string[] = [];

  afterEach(async () => {
    setDiscordRoleClientForTest(null);
    for (const orderId of orderIds) {
      // F-6 불변 트리거로 인해 이용권 DELETE는 거부됨 — 주문·주문 이벤트와 마찬가지로 잔여는 db:reset으로 정리.
      await admin.from("dead_letters").delete().contains("payload", { order_id: orderId });
      await admin.from("outbox_messages").delete().contains("payload", { order_id: orderId });
    }
    if (extraOutboxMessageIds.length > 0) {
      await admin.from("outbox_messages").delete().in("id", extraOutboxMessageIds);
    }
    for (const profile of profiles) {
      await admin.from("dead_letters").delete().contains("payload", { user_id: profile.id });
      await admin.from("outbox_messages").delete().contains("payload", { user_id: profile.id });
      await admin.from("discord_accounts").delete().eq("user_id", profile.id);
      await admin.from("users").update({ withdrawn_at: new Date().toISOString() }).eq("id", profile.id);
      await admin.auth.admin.deleteUser(profile.authUserId);
    }
    profiles = [];
    orderIds = [];
    extraOutboxMessageIds = [];
  });

  async function createProfile(_label: "STUDENT" | "ADMIN", options: { linkDiscord?: boolean } = {}): Promise<Profile> {
    const email = `vitest-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (authError || !authUser.user) throw new Error(`테스트 계정 생성 실패: ${authError?.message}`);
    const { data: profile, error: profileError } = await admin
      .from("users")
      // ADMIN은 트리거가 앱 경로의 insert 자체를 거부한다(e2e는 SQL로 승격). grant_order_access()는 행위자 역할을 호출자가
      // 넘기는 값(runCommand가 확정)으로 판단하고 행위자 id는 users 행이기만 하면 되므로, 여기서는 항상 STUDENT 행을 쓴다.
      .insert({ auth_user_id: authUser.user.id, email, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(`프로필 생성 실패: ${profileError?.message}`);
    const created = { id: profile.id as string, authUserId: authUser.user.id };
    profiles.push(created);
    if (options.linkDiscord) {
      const { error } = await admin
        .from("discord_accounts")
        .insert({ user_id: created.id, discord_id: `vitest-${authUser.user.id}` });
      if (error) throw new Error(`discord_accounts 픽스처 생성 실패: ${error.message}`);
    }
    return created;
  }

  // 승인된 미결제 신청서 한 건(상품 기반 — 개설강의 없이 만들 수 있어 가장 간단하다). grants는 상품의 부여 목록.
  async function createApprovedOrder(studentId: string, grants: unknown[] = []) {
    const { data: product, error: productError } = await admin
      .from("products")
      .insert({ name: `vitest-${randomUUID()}`, price: 1000, grants })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`상품 픽스처 생성 실패: ${productError?.message}`);
    const { data: order, error: orderError } = await admin
      .from("orders")
      .insert({ user_id: studentId, product_id: product.id, status: "APPROVED", approved_at: new Date().toISOString() })
      .select("id")
      .single();
    if (orderError || !order) throw new Error(`주문 픽스처 생성 실패: ${orderError?.message}`);
    orderIds.push(order.id as string);
    return order.id as string;
  }

  async function grantAccess(orderId: string, adminId: string) {
    const { data, error } = await admin.rpc("grant_order_access", {
      p_order_id: orderId,
      p_actor_id: adminId,
      p_actor_role: "ADMIN",
      p_reason: "vitest 직권 부여",
    });
    if (error) throw new Error(`직권 부여 실패: ${error.message}`);
    return data as string;
  }

  async function entitlementsOf(orderId: string) {
    const { data } = await admin
      .from("entitlements")
      .select("id, type, grant_source, payment_event_id, grant_event_id, revoked_at, revoked_reason, discord_role_removed_at")
      .eq("order_id", orderId)
      .order("type");
    return data ?? [];
  }

  async function factFor(orderId: string) {
    const { data } = await admin
      .from("outbox_messages")
      .select("id, attempts, processed_at, last_error, payload")
      .eq("topic", "ORDER_ACCESS_GRANTED")
      .eq("payload->>order_id", orderId);
    return data ?? [];
  }

  it("직권 부여 → 드레인: ADMIN_GRANT 이용권이 한 벌 생기고(결제 근거 없음) 사실은 처리 완료된다", async () => {
    const adminProfile = await createProfile("ADMIN");
    const student = await createProfile("STUDENT");
    const orderId = await createApprovedOrder(student.id);

    const eventId = await grantAccess(orderId, adminProfile.id);
    await runOutboxBatch();

    const { data: order } = await admin.from("orders").select("payment_status, status").eq("id", orderId).single();
    expect(order).toMatchObject({ payment_status: "WAIVED", status: "APPROVED" });

    const rows = await entitlementsOf(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "COURSE_ACCESS",
      grant_source: "ADMIN_GRANT",
      payment_event_id: null,
      grant_event_id: eventId,
      revoked_at: null,
    });

    const facts = await factFor(orderId);
    expect(facts).toHaveLength(1);
    expect(facts[0].processed_at).not.toBeNull();

    const { count: ledgerCount } = await admin
      .from("payment_events")
      .select("id", { count: "exact", head: true })
      .eq("order_id", orderId);
    expect(ledgerCount).toBe(0);
  });

  it("같은 사실이 다시 전달돼도(재처리) 이용권은 한 벌이다", async () => {
    const adminProfile = await createProfile("ADMIN");
    const student = await createProfile("STUDENT");
    const orderId = await createApprovedOrder(student.id);

    await grantAccess(orderId, adminProfile.id);
    await runOutboxBatch();

    const [fact] = await factFor(orderId);
    const { data: again, error } = await admin
      .from("outbox_messages")
      .insert({ topic: "ORDER_ACCESS_GRANTED", payload: fact.payload })
      .select("id")
      .single();
    if (error || !again) throw new Error(`아웃박스 메시지 생성 실패: ${error?.message}`);
    extraOutboxMessageIds.push(again.id as string);
    await runOutboxBatch();

    const { data: processedAgain } = await admin.from("outbox_messages").select("processed_at").eq("id", again.id).single();
    expect(processedAgain?.processed_at).not.toBeNull();
    expect(await entitlementsOf(orderId)).toHaveLength(1);
  });

  it("디스코드 역할이 걸린 상품: 연결된 학생이면 역할 이용권이 부여되고, 탈퇴 사실이 오면 같은 출구로 회수된다", async () => {
    setDiscordRoleClientForTest(createMockDiscordRoleClient({ mode: "success" }));
    const adminProfile = await createProfile("ADMIN");
    const student = await createProfile("STUDENT", { linkDiscord: true });
    const orderId = await createApprovedOrder(student.id, [
      { type: "COURSE_ACCESS" },
      { type: "DISCORD_ROLE", discord_role_id: "vitest-role" },
    ]);

    await grantAccess(orderId, adminProfile.id);
    await runOutboxBatch();

    const granted = await entitlementsOf(orderId);
    expect(granted.map((e) => e.type)).toEqual(["COURSE_ACCESS", "DISCORD_ROLE"]);
    expect(granted.every((e) => e.grant_source === "ADMIN_GRANT" && e.revoked_at === null)).toBe(true);
    expect((await factFor(orderId))[0].processed_at).not.toBeNull();

    const { error } = await admin.from("outbox_messages").insert({ topic: "USER_WITHDRAWN", payload: { user_id: student.id } });
    if (error) throw new Error(`탈퇴 사실 생성 실패: ${error.message}`);
    await runOutboxBatch();

    const revoked = await entitlementsOf(orderId);
    expect(revoked.every((e) => e.revoked_reason === "WITHDRAWN" && e.revoked_at !== null)).toBe(true);
    expect(revoked.find((e) => e.type === "DISCORD_ROLE")?.discord_role_removed_at).not.toBeNull();
  });

  it("디스코드 미연결 학생의 직권 부여는 기록을 남기고 보류되며(S-1과 같다), 연결 뒤 재시도에서 처리된다", async () => {
    setDiscordRoleClientForTest(createMockDiscordRoleClient({ mode: "success" }));
    const adminProfile = await createProfile("ADMIN");
    const student = await createProfile("STUDENT");
    const orderId = await createApprovedOrder(student.id, [{ type: "DISCORD_ROLE", discord_role_id: "vitest-role" }]);

    await grantAccess(orderId, adminProfile.id);
    await runOutboxBatch();

    const [held] = await factFor(orderId);
    expect(held.attempts).toBe(1);
    expect(held.processed_at).toBeNull();
    expect(held.last_error).toContain("디스코드 미연결");
    // 이용권(DB)은 이미 생겼고, 실패한 것은 디스코드 역할뿐이다 — 재시도돼도 중복되지 않는다.
    expect(await entitlementsOf(orderId)).toHaveLength(1);

    const { error } = await admin
      .from("discord_accounts")
      .insert({ user_id: student.id, discord_id: `vitest-${randomUUID()}` });
    if (error) throw new Error(`discord_accounts 픽스처 생성 실패: ${error.message}`);
    await admin.from("outbox_messages").update({ next_attempt_at: new Date().toISOString() }).eq("id", held.id);
    await runOutboxBatch();

    const [after] = await factFor(orderId);
    expect(after.processed_at).not.toBeNull();
    expect(await entitlementsOf(orderId)).toHaveLength(1);
  });

  describe("대사 — 직권 부여(WAIVED)인데 이용권이 없는 주문", () => {
    // 유예(10분)가 지난 직권 부여 기록을 만들려고 주문 이벤트를 과거 시각으로 직접 넣는다(함수는 항상 지금 시각으로 남긴다).
    async function waivedOrderWithOldGrantEvent(studentId: string, adminId: string) {
      const orderId = await createApprovedOrder(studentId);
      const { error: updateError } = await admin.from("orders").update({ payment_status: "WAIVED" }).eq("id", orderId);
      if (updateError) throw new Error(`WAIVED 픽스처 실패: ${updateError.message}`);
      const { data: event, error } = await admin
        .from("order_events")
        .insert({
          order_id: orderId,
          event_type: "ACCESS_GRANTED",
          actor: "ADMIN",
          actor_user_id: adminId,
          payload: { reason: "vitest" },
          created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
        })
        .select("id")
        .single();
      if (error || !event) throw new Error(`주문 이벤트 픽스처 실패: ${error?.message}`);
      return { orderId, eventId: event.id as string };
    }

    async function warningCount(orderId: string) {
      const { count } = await admin
        .from("dead_letters")
        .select("id", { count: "exact", head: true })
        .eq("source", "INTEGRITY")
        .eq("resolved", false)
        .contains("payload", { order_id: orderId, check: "WAIVED_ORDER_WITHOUT_ENTITLEMENTS" });
      return count ?? 0;
    }

    it("이용권이 없으면 경고하고(중복 적재 없음), 이용권이 있으면 경고하지 않는다", async () => {
      const adminProfile = await createProfile("ADMIN");
      const student = await createProfile("STUDENT");
      const missing = await waivedOrderWithOldGrantEvent(student.id, adminProfile.id);
      const granted = await waivedOrderWithOldGrantEvent(student.id, adminProfile.id);
      const { error } = await admin.rpc("grant_entitlements_for_order", {
        p_order_id: granted.orderId,
        p_user_id: student.id,
        p_source: "ADMIN_GRANT",
        p_source_id: granted.eventId,
        p_grants: null,
      });
      if (error) throw new Error(`이용권 픽스처 실패: ${error.message}`);

      await checkSystemIntegrity();
      await checkSystemIntegrity();

      expect(await warningCount(missing.orderId)).toBe(1);
      expect(await warningCount(granted.orderId)).toBe(0);
    });
  });
});
