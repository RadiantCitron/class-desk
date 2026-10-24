import { describe, it, expect, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { runOutboxBatch } from "@/lib/wiring/outbox";
import { setDiscordRoleClientForTest } from "@/lib/discord/bot";
import { createMockDiscordRoleClient } from "@/lib/discord/mock-role-client";

// 이 파일은 통합 테스트다 — 실제 로컬 Supabase가 떠 있어야 한다(`npm run db:start`).
// `npm run test`(단위 테스트)에서는 제외되고 `npm run test:integration`으로만 돈다.
// (supabase/tests/integrity_check.sql이 DB 레벨 명세라면, 이 파일은 drain.ts의 TS 레벨 동작을
// 같은 원칙으로 검증하는 짝이다 — SQL로는 record_payment_event()까지만 검증 가능하고,
// 그 뒤 아웃박스를 실제로 소비하는 TS 코드(lib/outbox/drain.ts)는 SQL로 테스트할 수 없다.)

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다. .env.local을 확인하고 " +
      "`npm run db:start`로 로컬 Supabase를 띄운 뒤 다시 실행하세요.",
  );
}

const admin = createClient(url, key, { auth: { persistSession: false } });

async function countDlqFor(userId: string) {
  const { count } = await admin
    .from("dead_letters")
    .select("id", { count: "exact", head: true })
    .eq("source", "OUTBOX")
    .contains("payload", { user_id: userId });
  return count ?? 0;
}

// 드레인 1회가 대사 점검(checkSystemIntegrity)까지 돌아 로컬 잔여 행이 쌓일수록 느려진다 — 이 파일만 60초.
describe("아웃박스 드레인 — 통합 테스트(로컬 Supabase 필요)", { timeout: 60_000 }, () => {
  // authUserId(auth.users.id)와 profileId(public.users.id)는 2026-09-12 식별자 분리 이후
  // 서로 다른 값이다 — outbox payload의 user_id는 항상 profileId여야 한다.
  let createdAuthUserId: string | null = null;
  let createdProfileId: string | null = null;
  let outboxMessageId: string | null = null;
  let extraOutboxMessageIds: string[] = [];
  let createdEntitlementIds: string[] = [];

  afterEach(async () => {
    // Open-2 mock 주입이 다른 it로 새지 않게 live로 되돌린다.
    setDiscordRoleClientForTest(null);
    if (outboxMessageId) {
      await admin.from("outbox_messages").delete().eq("id", outboxMessageId);
      outboxMessageId = null;
    }
    if (extraOutboxMessageIds.length > 0) {
      await admin.from("outbox_messages").delete().in("id", extraOutboxMessageIds);
      extraOutboxMessageIds = [];
    }
    if (createdEntitlementIds.length > 0) {
      // F-6 불변 트리거로 인해 이용권 DELETE는 거부됨 — 잔여는 db:reset.
      createdEntitlementIds = [];
    }
    // 결제 원장·주문·상품(·주문 이벤트)은 지우지 않는다 — 원장·이벤트는 DB 트리거가, 주문·상품은 FK가 막아 예전 delete는 대부분 조용히 실패했다. 잔여는 db:reset.
    if (createdProfileId) {
      // 탈퇴 정책은 테스트 코드도 예외가 아니다(2026-09-12
      // "테스트도 지우지 않게 바꿈") — public.users는 소프트 탈퇴만, 실제 삭제는 auth 계정만.
      await admin.from("discord_accounts").delete().eq("user_id", createdProfileId);
      await admin.from("users").update({ withdrawn_at: new Date().toISOString() }).eq("id", createdProfileId);
      createdProfileId = null;
    }
    if (createdAuthUserId) {
      await admin.auth.admin.deleteUser(createdAuthUserId);
      createdAuthUserId = null;
    }
  });

  async function createTestProfile(options: { linkDiscord?: boolean } = {}) {
    const email = `vitest-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(`테스트 계정 생성 실패: ${authError?.message}`);
    createdAuthUserId = authUser.user.id;

    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({
        auth_user_id: createdAuthUserId,
        email,
        role: "STUDENT",
      })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(`프로필 생성 실패: ${profileError?.message}`);
    createdProfileId = profile.id;

    if (options.linkDiscord === false) return profile.id as string;

    // discord_id는 2026-09-27부터 users가 아니라 discord_accounts(이용권 모듈)에만 있다 —
    // 이용권 핸들러가 실제로 그 테이블을 읽는지 재현하려면 여기 넣어야 한다.
    const { error: discordError } = await admin.from("discord_accounts").insert({
      user_id: profile.id,
      discord_id: `vitest-${createdAuthUserId}`,
    });
    if (discordError) throw new Error(`discord_accounts 픽스처 생성 실패: ${discordError?.message}`);

    return profile.id as string;
  }

  // 이용권 픽스처의 부여 근거 — E-1(ADR-0019)부터 모든 이용권은 근거(결제 원장 행)를 가져야 한다
  // (entitlements_grant_source_pair). 직접 넣는 이용권 픽스처는 이 근거 한 벌을 쓴다.
  async function createPaymentSource(profileId: string) {
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
    const { data: paymentEvent, error: paymentEventError } = await admin
      .from("payment_events")
      .insert({
        order_id: order.id,
        event_type: "PAYMENT_SUCCEEDED",
        amount: 1000,
        provider: "MOCK",
        provider_event_id: `vitest-${randomUUID()}`,
      })
      .select("id")
      .single();
    if (paymentEventError || !paymentEvent) throw new Error(`결제 원장 픽스처 생성 실패: ${paymentEventError?.message}`);
    return { order_id: order.id as string, payment_event_id: paymentEvent.id as string };
  }

  it("성공 케이스: 회수할 이용권이 없는 ORDER_REFUNDED는 아무것도 바꾸지 않고 processed_at만 채운다", async () => {
    const email = `vitest-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(`테스트 계정 생성 실패: ${authError?.message}`);
    createdAuthUserId = authUser.user.id;

    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({
        auth_user_id: createdAuthUserId,
        email,
        role: "STUDENT",
      })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(`프로필 생성 실패: ${profileError?.message}`);
    createdProfileId = profile.id;

    const { data: message, error: insertError } = await admin
      .from("outbox_messages")
      .insert({
        topic: "ORDER_REFUNDED",
        payload: { order_id: randomUUID(), user_id: createdProfileId, payment_event_id: randomUUID() },
      })
      .select("id")
      .single();
    if (insertError || !message) throw new Error(`아웃박스 메시지 생성 실패: ${insertError?.message}`);
    outboxMessageId = message.id;

    await runOutboxBatch();

    const { data: after } = await admin
      .from("outbox_messages")
      .select("processed_at, attempts")
      .eq("id", message.id)
      .single();

    expect(after?.processed_at).not.toBeNull();
    expect(after?.attempts).toBe(0);
  });

  // 영구 실패 메시지가 반복 재시도될 때 DLQ 중복 적재 방지 회귀 테스트:
  it("사각지대: 영구 실패 메시지는 재시도될수록 attempts는 계속 늘지만 DLQ 알림은 최초 1건에서 늘지 않는다", async () => {
    const fakeUserId = randomUUID(); // users 테이블에 존재하지 않는 id — 영구 실패를 유도

    const { data: message, error: insertError } = await admin
      .from("outbox_messages")
      .insert({
        topic: "ORDER_PAID",
        payload: {
          order_id: randomUUID(),
          user_id: fakeUserId,
          payment_event_id: randomUUID(),
          grants: [],
        },
      })
      .select("id")
      .single();
    if (insertError || !message) throw new Error(`아웃박스 메시지 생성 실패: ${insertError?.message}`);
    outboxMessageId = message.id;

    const dlqCountBefore = await countDlqFor(fakeUserId);

    // 실제 운영에서는 backoff(최대 60분)를 기다려야 재시도되지만, 테스트에서는 next_attempt_at을
    // 강제로 앞당겨 "여러 번 재시도된 상황"을 곧바로 재현한다.
    for (let i = 0; i < 3; i++) {
      await admin
        .from("outbox_messages")
        .update({ next_attempt_at: new Date().toISOString() })
        .eq("id", message.id);
      await runOutboxBatch();
    }

    const { data: after } = await admin
      .from("outbox_messages")
      .select("attempts, processed_at")
      .eq("id", message.id)
      .single();

    // attempts는 계속 실패 중임을 보여주려고 늘어난다 — 이건 정상이다.
    expect(after?.attempts).toBe(3);
    expect(after?.processed_at).toBeNull();

    // 이게 진짜 사각지대다: 3번 실패했는데 DLQ엔 여전히 1건뿐이다. 관리자가 그 1건을
    // "처리완료"로 넘기면, 이 메시지는 이 시점부터 아무 신호도 없이 영구히 실패만 반복한다.
    const dlqCountAfter = await countDlqFor(fakeUserId);
    expect(dlqCountAfter - dlqCountBefore).toBe(1);
  });

  // 탈퇴 사실(USER_WITHDRAWN)이 연동표를 거쳐 이용권 모듈의 회수 핸들러에
  // 도달하는지. 회수할 이용권이 없는 사용자라 핸들러는 조회만 하고 끝나며, 메시지는 처리 완료가
  // 돼야 한다(연동표에 토픽이 빠져 있으면 "연동표에 없는 토픽"으로 실패해 attempts가 1이 된다).
  it("USER_WITHDRAWN은 연동표를 거쳐 처리 완료된다", async () => {
    const { data: message, error: insertError } = await admin
      .from("outbox_messages")
      .insert({ topic: "USER_WITHDRAWN", payload: { user_id: randomUUID() } })
      .select("id")
      .single();
    if (insertError || !message) throw new Error(`아웃박스 메시지 생성 실패: ${insertError?.message}`);
    outboxMessageId = message.id;

    await runOutboxBatch();

    const { data: after } = await admin
      .from("outbox_messages")
      .select("processed_at, attempts")
      .eq("id", message.id)
      .single();
    expect(after?.processed_at).not.toBeNull();
    expect(after?.attempts).toBe(0);
  });

  // 러너가 같은 메시지를 동시에 두 번 처리하면 이용권이 2벌
  // 생기던 결함의 회귀 테스트. claim_outbox_messages()의 for update skip locked가 막는다.
  it("동시성: 같은 ORDER_PAID 메시지를 두 러너가 동시에 처리해도 이용권은 한 벌만 생긴다", async () => {
    const profileId = await createTestProfile();

    // entitlements.order_id/payment_event_id는 각각 orders(id)/payment_events(id)를
    // 참조한다(FK) — 실제 존재하는 행이 있어야 한다. products는 course_offering 없이도
    // 만들 수 있어 가장 간단하다.
    const { data: product, error: productError } = await admin
      .from("products")
      .insert({ name: `vitest-${randomUUID()}`, price: 1000 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`상품 픽스처 생성 실패: ${productError?.message}`);

    const { data: order, error: orderError } = await admin
      .from("orders")
      .insert({
        user_id: profileId,
        product_id: product.id,
        status: "APPROVED",
        approved_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (orderError || !order) throw new Error(`주문 픽스처 생성 실패: ${orderError?.message}`);

    const { data: paymentEvent, error: paymentEventError } = await admin
      .from("payment_events")
      .insert({
        order_id: order.id,
        event_type: "PAYMENT_SUCCEEDED",
        amount: 1000,
        provider: "MOCK",
        provider_event_id: `vitest-${randomUUID()}`,
      })
      .select("id")
      .single();
    if (paymentEventError || !paymentEvent)
      throw new Error(`결제 원장 픽스처 생성 실패: ${paymentEventError?.message}`);
    const paymentEventId = paymentEvent.id;

    const { data: message, error: insertError } = await admin
      .from("outbox_messages")
      .insert({
        topic: "ORDER_PAID",
        payload: {
          order_id: order.id,
          user_id: profileId,
          payment_event_id: paymentEventId,
          grants: [{ type: "COURSE_ACCESS" }],
        },
      })
      .select("id")
      .single();
    if (insertError || !message) throw new Error(`아웃박스 메시지 생성 실패: ${insertError?.message}`);
    outboxMessageId = message.id;

    await Promise.all([runOutboxBatch(), runOutboxBatch()]);

    const { data: entitlements } = await admin
      .from("entitlements")
      .select("id")
      .eq("payment_event_id", paymentEventId);
    createdEntitlementIds = (entitlements ?? []).map((e) => e.id);

    expect(entitlements ?? []).toHaveLength(1);
  });

  // S-1(2026-10-08) — 디스코드 미연결이면 예전엔 기록 없이 처리 완료가 됐다. 이제 실패로 남고(재시도·DLQ),
  // 학생이 연결하면 다음 드레인에서 역할이 나가 처리 완료된다. 이용권은 한 벌만.
  it("디스코드 미연결 학생의 ORDER_PAID는 기록을 남기고 보류되며, 연결 뒤 재시도에서 처리된다", async () => {
    setDiscordRoleClientForTest(createMockDiscordRoleClient({ mode: "success" }));
    const profileId = await createTestProfile({ linkDiscord: false });

    const { data: product, error: productError } = await admin
      .from("products")
      .insert({ name: `vitest-${randomUUID()}`, price: 1000 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`상품 픽스처 생성 실패: ${productError?.message}`);

    const { data: order, error: orderError } = await admin
      .from("orders")
      .insert({
        user_id: profileId,
        product_id: product.id,
        status: "APPROVED",
        approved_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (orderError || !order) throw new Error(`주문 픽스처 생성 실패: ${orderError?.message}`);

    const { data: paymentEvent, error: paymentEventError } = await admin
      .from("payment_events")
      .insert({
        order_id: order.id,
        event_type: "PAYMENT_SUCCEEDED",
        amount: 1000,
        provider: "MOCK",
        provider_event_id: `vitest-${randomUUID()}`,
      })
      .select("id")
      .single();
    if (paymentEventError || !paymentEvent) {
      throw new Error(`결제 원장 픽스처 생성 실패: ${paymentEventError?.message}`);
    }

    const { data: message, error: insertError } = await admin
      .from("outbox_messages")
      .insert({
        topic: "ORDER_PAID",
        payload: {
          order_id: order.id,
          user_id: profileId,
          payment_event_id: paymentEvent.id,
          grants: [{ type: "DISCORD_ROLE", discord_role_id: "vitest-role" }],
        },
      })
      .select("id")
      .single();
    if (insertError || !message) throw new Error(`아웃박스 메시지 생성 실패: ${insertError?.message}`);
    outboxMessageId = message.id;

    await runOutboxBatch();

    const { data: afterSkip } = await admin
      .from("outbox_messages")
      .select("attempts, processed_at, last_error")
      .eq("id", message.id)
      .single();
    expect(afterSkip?.attempts).toBe(1);
    expect(afterSkip?.processed_at).toBeNull();
    expect(afterSkip?.last_error).toContain("디스코드 미연결");
    expect(await countDlqFor(profileId)).toBe(1);

    const { data: entitlementsAfterSkip } = await admin
      .from("entitlements")
      .select("id")
      .eq("payment_event_id", paymentEvent.id);
    createdEntitlementIds = (entitlementsAfterSkip ?? []).map((e) => e.id);
    expect(entitlementsAfterSkip ?? []).toHaveLength(1);

    // 학생이 디스코드를 연결했다 → 재시도 시각을 앞당겨 다음 드레인이 바로 집게 한다.
    const { error: linkError } = await admin
      .from("discord_accounts")
      .insert({ user_id: profileId, discord_id: `vitest-${randomUUID()}` });
    if (linkError) throw new Error(`discord_accounts 픽스처 생성 실패: ${linkError.message}`);
    await admin.from("outbox_messages").update({ next_attempt_at: new Date().toISOString() }).eq("id", message.id);

    await runOutboxBatch();

    const { data: afterLink } = await admin
      .from("outbox_messages")
      .select("attempts, processed_at")
      .eq("id", message.id)
      .single();
    expect(afterLink?.processed_at).not.toBeNull();
    expect(await countDlqFor(profileId)).toBe(1);

    const { data: entitlementsAfterLink } = await admin
      .from("entitlements")
      .select("id")
      .eq("payment_event_id", paymentEvent.id);
    expect(entitlementsAfterLink ?? []).toHaveLength(1);
  });

  // + F-17 — mock 실패로 실 Discord env에 의존하지 않는다.
  it("회수 안전: 디스코드 역할 회수가 실패해도 USER_WITHDRAWN이 오면 COURSE_ACCESS는 즉시 회수된다", async () => {
    setDiscordRoleClientForTest(createMockDiscordRoleClient({ mode: "failure" }));
    const profileId = await createTestProfile();
    const source = await createPaymentSource(profileId);

    const { data: entitlements, error: entError } = await admin
      .from("entitlements")
      .insert([
        {
          ...source,
          user_id: profileId,
          type: "COURSE_ACCESS",
          access_code: `VITEST${randomUUID().slice(0, 10)}`,
          // 여러 행을 한 번에 insert할 때 PostgREST는 행마다 다른 컬럼 집합이면 빠진 컬럼을
          // 테이블 기본값이 아니라 명시적 NULL로 보낸다 — metadata가 NOT NULL이라 명시한다.
          metadata: {},
        },
        {
          ...source,
          user_id: profileId,
          type: "DISCORD_ROLE",
          access_code: `VITEST${randomUUID().slice(0, 10)}`,
          metadata: { discord_role_id: "vitest-role" },
        },
      ])
      .select("id, type");
    if (entError || !entitlements) throw new Error(`이용권 픽스처 생성 실패: ${entError?.message}`);
    createdEntitlementIds = entitlements.map((e) => e.id);

    const { data: message, error: insertError } = await admin
      .from("outbox_messages")
      .insert({ topic: "USER_WITHDRAWN", payload: { user_id: profileId } })
      .select("id")
      .single();
    if (insertError || !message) throw new Error(`아웃박스 메시지 생성 실패: ${insertError?.message}`);
    outboxMessageId = message.id;

    await runOutboxBatch();

    const { data: after } = await admin
      .from("entitlements")
      .select("type, revoked_at, revoked_reason, discord_role_removed_at")
      .in("id", createdEntitlementIds);

    const courseAccess = after?.find((e) => e.type === "COURSE_ACCESS");
    const discordRole = after?.find((e) => e.type === "DISCORD_ROLE");

    // 접근권은 이미 회수됐다(디스코드 성공 여부와 무관) — 이게 C3의 핵심.
    expect(courseAccess?.revoked_at).not.toBeNull();
    expect(courseAccess?.revoked_reason).toBe("WITHDRAWN");
    expect(discordRole?.revoked_at).not.toBeNull();
    // mock 실패라 역할 회수 표시는 안 남고, 메시지는 재시도 대상으로 남는다.
    expect(discordRole?.discord_role_removed_at).toBeNull();

    const { data: outboxAfter } = await admin
      .from("outbox_messages")
      .select("processed_at, attempts")
      .eq("id", message.id)
      .single();
    expect(outboxAfter?.processed_at).toBeNull();
    expect(outboxAfter?.attempts).toBe(1);
  });

  // 위 실패 케이스(env 없음)는 유지하고, mock 성공이면 역할 회수 표시까지
  // 끝나 메시지가 처리 완료된다(실 Discord HTTP 없음).
  it("회수 성공: mock 디스코드면 USER_WITHDRAWN이 discord_role_removed_at까지 남기고 처리 완료된다", async () => {
    setDiscordRoleClientForTest(createMockDiscordRoleClient({ mode: "success" }));
    const profileId = await createTestProfile();
    const source = await createPaymentSource(profileId);

    const { data: entitlements, error: entError } = await admin
      .from("entitlements")
      .insert([
        {
          ...source,
          user_id: profileId,
          type: "COURSE_ACCESS",
          access_code: `VITEST${randomUUID().slice(0, 10)}`,
          metadata: {},
        },
        {
          ...source,
          user_id: profileId,
          type: "DISCORD_ROLE",
          access_code: `VITEST${randomUUID().slice(0, 10)}`,
          metadata: { discord_role_id: "vitest-role" },
        },
      ])
      .select("id, type");
    if (entError || !entitlements) throw new Error(`이용권 픽스처 생성 실패: ${entError?.message}`);
    createdEntitlementIds = entitlements.map((e) => e.id);

    const { data: message, error: insertError } = await admin
      .from("outbox_messages")
      .insert({ topic: "USER_WITHDRAWN", payload: { user_id: profileId } })
      .select("id")
      .single();
    if (insertError || !message) throw new Error(`아웃박스 메시지 생성 실패: ${insertError?.message}`);
    outboxMessageId = message.id;

    await runOutboxBatch();

    const { data: after } = await admin
      .from("entitlements")
      .select("type, revoked_at, discord_role_removed_at")
      .in("id", createdEntitlementIds);

    const courseAccess = after?.find((e) => e.type === "COURSE_ACCESS");
    const discordRole = after?.find((e) => e.type === "DISCORD_ROLE");

    expect(courseAccess?.revoked_at).not.toBeNull();
    expect(discordRole?.revoked_at).not.toBeNull();
    expect(discordRole?.discord_role_removed_at).not.toBeNull();

    const { data: outboxAfter } = await admin
      .from("outbox_messages")
      .select("processed_at, attempts")
      .eq("id", message.id)
      .single();
    expect(outboxAfter?.processed_at).not.toBeNull();
    expect(outboxAfter?.attempts).toBe(0);
  });

  it("최대 재시도(10회) 초과 시 dead_at이 찍히고, 이후 배치가 그 메시지를 다시 집지 않는다", async () => {
    // 일부러 실패하는 페이로드(user_id 없음) — 디스코드 등 외부 의존 없이 결정적으로 재현된다.
    const { data: message, error: insertError } = await admin
      .from("outbox_messages")
      .insert({ topic: "USER_WITHDRAWN", payload: {}, attempts: 9 })
      .select("id")
      .single();
    if (insertError || !message) throw new Error(`픽스처 생성 실패: ${insertError?.message}`);

    await runOutboxBatch();

    const { data: afterFirst } = await admin
      .from("outbox_messages")
      .select("attempts, dead_at, processed_at")
      .eq("id", message.id)
      .single();
    expect(afterFirst?.attempts).toBe(10);
    expect(afterFirst?.dead_at).not.toBeNull();
    expect(afterFirst?.processed_at).toBeNull();

    // dead_at이 찍힌 메시지는 claim_outbox_messages()가 더 이상 집지 않는다 — 한 번 더 돌려도
    // attempts가 그대로여야 한다(재시도 자체가 안 일어남).
    await runOutboxBatch();

    const { data: afterSecond } = await admin
      .from("outbox_messages")
      .select("attempts")
      .eq("id", message.id)
      .single();
    expect(afterSecond?.attempts).toBe(10);

    await admin.from("outbox_messages").delete().eq("id", message.id);
    await admin.from("dead_letters").delete().contains("payload", { outbox_message_id: message.id });
  });

  // 장애유형교차카탈로그.md 4-2 — 예전엔 reset_dead_outbox_message()가 attempts를 리셋하지
  // 않아서, 관리자가 되살린 메시지가 한 번만 더 실패해도(attempts=11>=MAX_ATTEMPTS) 즉시
  // 다시 dead_at이 찍혔다. "재시도"가 실제로 새 10번의 기회를 주는지 확인한다.
  it("죽은 메시지를 reset_dead_outbox_message()로 되살리면 attempts가 0으로 돌아간다", async () => {
    const { data: message, error: insertError } = await admin
      .from("outbox_messages")
      .insert({
        topic: "USER_WITHDRAWN",
        payload: {},
        attempts: 10,
        dead_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (insertError || !message) throw new Error(`픽스처 생성 실패: ${insertError?.message}`);

    const { error: resetError } = await admin.rpc("reset_dead_outbox_message", {
      p_outbox_message_id: message.id,
    });
    expect(resetError).toBeNull();

    const { data: afterReset } = await admin
      .from("outbox_messages")
      .select("attempts, dead_at")
      .eq("id", message.id)
      .single();
    expect(afterReset?.attempts).toBe(0);
    expect(afterReset?.dead_at).toBeNull();

    // 되살린 메시지가 한 번 더 실패해도(같은 영구 실패 페이로드) 즉시 dead_at이 다시 찍히지
    // 않아야 한다 — attempts가 0부터 다시 세므로 이번엔 9번 더 견뎌야 죽는다.
    await runOutboxBatch();

    const { data: afterOneMoreFailure } = await admin
      .from("outbox_messages")
      .select("attempts, dead_at")
      .eq("id", message.id)
      .single();
    expect(afterOneMoreFailure?.attempts).toBe(1);
    expect(afterOneMoreFailure?.dead_at).toBeNull();

    await admin.from("outbox_messages").delete().eq("id", message.id);
    await admin.from("dead_letters").delete().contains("payload", { outbox_message_id: message.id });
  });

  // 위 "사각지대" 테스트와 같은 실패 유도(없는 user_id)로 1회 실패시킨 뒤,
  // 페이로드를 실존 사용자·주문으로 고쳐 다음 드레인에서 회복되는지 본다.
  it("드레인 1회 실패 후 원인을 고치면 다음 드레인에서 처리된다", async () => {
    const fakeUserId = randomUUID();
    const { data: message, error: insertError } = await admin
      .from("outbox_messages")
      .insert({
        topic: "ORDER_PAID",
        payload: {
          order_id: randomUUID(),
          user_id: fakeUserId,
          payment_event_id: randomUUID(),
          grants: [],
        },
      })
      .select("id")
      .single();
    if (insertError || !message) throw new Error(`아웃박스 메시지 생성 실패: ${insertError?.message}`);
    outboxMessageId = message.id;

    await runOutboxBatch();

    const { data: afterFail } = await admin
      .from("outbox_messages")
      .select("attempts, processed_at")
      .eq("id", message.id)
      .single();
    expect(afterFail?.attempts).toBe(1);
    expect(afterFail?.processed_at).toBeNull();

    const profileId = await createTestProfile();
    const { data: product, error: productError } = await admin
      .from("products")
      .insert({ name: `vitest-${randomUUID()}`, price: 1000 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`상품 픽스처 생성 실패: ${productError?.message}`);

    const { data: order, error: orderError } = await admin
      .from("orders")
      .insert({
        user_id: profileId,
        product_id: product.id,
        status: "APPROVED",
        approved_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (orderError || !order) throw new Error(`주문 픽스처 생성 실패: ${orderError?.message}`);

    const { data: paymentEvent, error: paymentEventError } = await admin
      .from("payment_events")
      .insert({
        order_id: order.id,
        event_type: "PAYMENT_SUCCEEDED",
        amount: 1000,
        provider: "MOCK",
        provider_event_id: `vitest-${randomUUID()}`,
      })
      .select("id")
      .single();
    if (paymentEventError || !paymentEvent) {
      throw new Error(`결제 원장 픽스처 생성 실패: ${paymentEventError?.message}`);
    }

    await admin
      .from("outbox_messages")
      .update({
        next_attempt_at: new Date().toISOString(),
        payload: {
          order_id: order.id,
          user_id: profileId,
          payment_event_id: paymentEvent.id,
          grants: [{ type: "COURSE_ACCESS" }],
        },
      })
      .eq("id", message.id);

    await runOutboxBatch();

    const { data: afterOk } = await admin
      .from("outbox_messages")
      .select("processed_at")
      .eq("id", message.id)
      .single();
    expect(afterOk?.processed_at).not.toBeNull();
  });
});
