import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { endExpiredOfferings } from "@/lib/orders/auto-end";
import { runOutboxBatch } from "@/lib/wiring/outbox";
import { checkSystemIntegrity } from "@/lib/integrity/checks";
import { setDiscordRoleClientForTest } from "@/lib/discord/bot";
import { createMockDiscordRoleClient } from "@/lib/discord/mock-role-client";

// 이 파일은 통합 테스트다 — 실제 로컬 Supabase가 필요하다(`npm run db:start`). [로컬] 전용(디스코드는 mock).
// 종강일이 지난 개설강의의 자동 종료(크론 단계) → 이용권·디스코드 역할 전부 회수, 수동 종료 설정은 건드리지 않음,
// 한 건이 실패해도 계속, 종료 취소(재부여, 다시 자동 종료되지 않음), 종료 후 환불 사실이 와도 회수 사유가 덮어써지지 않음, 대사 경고.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다. .env.local을 확인하고 " +
      "`npm run db:start`로 로컬 Supabase를 띄운 뒤 다시 실행하세요.",
  );
}
const admin = createClient(url, key, { auth: { persistSession: false } });

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

describe("강의 종료 — 통합 테스트(로컬 Supabase 필요)", { timeout: 90_000 }, () => {
  let profiles: { id: string; authUserId: string }[] = [];
  let offeringIds: string[] = [];
  let orderIds: string[] = [];

  afterEach(async () => {
    setDiscordRoleClientForTest(null);
    for (const orderId of orderIds) {
      // F-6 불변 트리거로 인해 이용권 DELETE는 거부됨 — 잔여는 db:reset.
      await admin.from("dead_letters").delete().contains("payload", { order_id: orderId });
      await admin.from("outbox_messages").delete().contains("payload", { order_id: orderId });
    }
    const { data: anyUser } = await admin.from("users").select("id").limit(1).single();
    for (const id of offeringIds) {
      await admin.from("dead_letters").delete().contains("payload", { offering_id: id });
      // 이후 대사가 이 테스트의 강의를 계속 경고하지 않게 종료 처리하고, 학생 신청 화면에 남지 않게 소프트 삭제한다 — 모집중·디스코드 역할이 걸린 채로
      // 남으면 다른 e2e(온라인 수업 안내 배너)가 이 강의 때문에 틀어진다. 개설강의·주문은 지우지 않는다(/FK, 잔여는 db:reset).
      await admin.from("course_offerings").update({ ended_at: new Date().toISOString(), end_note: "vitest 정리" }).eq("id", id).is("ended_at", null);
      if (anyUser) {
        await admin
          .from("course_offerings")
          .update({ deleted_at: new Date().toISOString(), deleted_reason: "vitest 정리", deleted_by: anyUser.id })
          .eq("id", id);
      }
    }
    for (const p of profiles) {
      await admin.from("dead_letters").delete().contains("payload", { user_id: p.id });
      await admin.from("outbox_messages").delete().contains("payload", { user_id: p.id });
      await admin.from("discord_accounts").delete().eq("user_id", p.id);
      await admin.from("users").update({ withdrawn_at: new Date().toISOString() }).eq("id", p.id);
      await admin.auth.admin.deleteUser(p.authUserId);
    }
    profiles = [];
    offeringIds = [];
    orderIds = [];
  });

  async function profile(options: { linkDiscord?: boolean } = {}) {
    const email = `vitest-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (authError || !authUser.user) throw new Error(authError?.message);
    const { data: row, error } = await admin.from("users").insert({ auth_user_id: authUser.user.id, email, role: "STUDENT" }).select("id").single();
    if (error || !row) throw new Error(error?.message);
    const p = { id: row.id as string, authUserId: authUser.user.id };
    profiles.push(p);
    if (options.linkDiscord) {
      const { error: linkError } = await admin.from("discord_accounts").insert({ user_id: p.id, discord_id: `vitest-${authUser.user.id}` });
      if (linkError) throw new Error(linkError.message);
    }
    return p.id;
  }

  async function offering(over: Record<string, unknown> = {}) {
    const { data: course, error: courseError } = await admin.from("courses").insert({ name: `vitest-end-${randomUUID()}` }).select("id").single();
    if (courseError || !course) throw new Error(courseError?.message);
    const { data, error } = await admin
      .from("course_offerings")
      .insert({
        course_id: course.id,
        label: "end",
        capacity: 9,
        remaining_seats: 9,
        price: 10000,
        location: "test",
        recruit_opens_at: day(-10),
        opens_at: day(-5),
        ends_at: day(-1),
        status: "OPEN",
        grants: [{ type: "COURSE_ACCESS" }, { type: "DISCORD_ROLE", discord_role_id: "vitest-role" }],
        required_terms_types: [],
        ...over,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message);
    offeringIds.push(data.id as string);
    return data.id as string;
  }

  // 결제 완료 주문 + 결제 원장 + 이용권(결제 근거) 한 벌 — 종료 때 회수될 대상.
  async function paidEnrollment(offeringId: string, userId: string) {
    const orderId = randomUUID();
    const { error } = await admin.from("orders").insert({
      id: orderId,
      user_id: userId,
      course_offering_id: offeringId,
      status: "APPROVED",
      payment_status: "PAID",
      list_price: 10000,
      final_amount: 10000,
      approved_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
      payment_method: "CARD",
    });
    if (error) throw new Error(error.message);
    orderIds.push(orderId);
    const { data: payment, error: paymentError } = await admin
      .from("payment_events")
      .insert({ provider: "TOSS", provider_event_id: `vitest-end-${orderId}`, event_type: "PAYMENT_SUCCEEDED", amount: 10000, currency: "KRW", order_id: orderId, payment_method: "CARD" })
      .select("id")
      .single();
    if (paymentError || !payment) throw new Error(paymentError?.message);
    const { error: grantError } = await admin.rpc("grant_entitlements_for_order", {
      p_order_id: orderId,
      p_user_id: userId,
      p_source: "PAYMENT",
      p_source_id: payment.id,
      p_grants: [{ type: "COURSE_ACCESS" }, { type: "DISCORD_ROLE", discord_role_id: "vitest-role" }],
    });
    if (grantError) throw new Error(grantError.message);
    return { orderId, paymentId: payment.id as string };
  }

  async function entitlements(orderId: string) {
    const { data } = await admin
      .from("entitlements")
      .select("type, grant_source, revoked_at, revoked_reason, discord_role_removed_at")
      .eq("order_id", orderId)
      .order("granted_at")
      .order("type");
    return data ?? [];
  }

  async function offeringRow(id: string) {
    const { data } = await admin.from("course_offerings").select("ended_at, ended_by, end_note, manual_end, status").eq("id", id).single();
    return data!;
  }

  it("자동 종료: 종강일이 지난 자동 설정 강의만 종료되고 이용권·디스코드 역할이 회수되며, 수동 설정·종강일 없는 강의는 건드리지 않고, 다시 돌려도 멱등", async () => {
    setDiscordRoleClientForTest(createMockDiscordRoleClient({ mode: "success" }));
    const auto = await offering();
    const manual = await offering({ manual_end: true });
    const noEnd = await offering({ ends_at: null });
    const student = await profile({ linkDiscord: true });
    const enrollment = await paidEnrollment(auto, student);
    const manualStudent = await profile({ linkDiscord: true });
    const manualEnrollment = await paidEnrollment(manual, manualStudent);

    const first = await endExpiredOfferings();
    expect(first.failed).toBe(0);
    expect(first.ended).toBeGreaterThanOrEqual(1);

    const autoRow = await offeringRow(auto);
    expect(autoRow).toMatchObject({ ended_by: null, end_note: "기간 만료 자동 종료", status: "OPEN" });
    expect(autoRow.ended_at).not.toBeNull();
    expect((await offeringRow(manual)).ended_at).toBeNull();
    expect((await offeringRow(noEnd)).ended_at).toBeNull();

    // 주문·결제 상태는 그대로, 이용권은 드레인 뒤 COURSE_ENDED로 회수 + 디스코드 역할 회수 표시
    await runOutboxBatch();
    const { data: order } = await admin.from("orders").select("status, payment_status").eq("id", enrollment.orderId).single();
    expect(order).toMatchObject({ status: "APPROVED", payment_status: "PAID" });
    const revoked = await entitlements(enrollment.orderId);
    expect(revoked).toHaveLength(2);
    expect(revoked.every((e) => e.revoked_reason === "COURSE_ENDED" && e.revoked_at !== null)).toBe(true);
    expect(revoked.find((e) => e.type === "DISCORD_ROLE")?.discord_role_removed_at).not.toBeNull();
    // 수동 설정 강의의 수강생은 그대로
    expect((await entitlements(manualEnrollment.orderId)).every((e) => e.revoked_at === null)).toBe(true);

    // 멱등: 다시 돌려도 이미 종료된 강의는 대상이 아니고 사실이 더 쌓이지 않는다
    await endExpiredOfferings();
    const { count } = await admin.from("outbox_messages").select("id", { count: "exact", head: true }).eq("topic", "ORDER_COURSE_ENDED").contains("payload", { order_id: enrollment.orderId });
    expect(count).toBe(1);
  });

  it("한 강의의 종료가 실패해도 나머지는 계속되고, 실패는 DLQ(INTERNAL)에 남는다", async () => {
    // 개강 전인데 종강일만 지난 비정상 강의 — end_course_offering이 거부한다(자동 종료 대상 조회에는 걸린다).
    const broken = await offering({ opens_at: day(5), ends_at: day(-1), recruit_opens_at: day(-10) });
    const fine = await offering();

    const result = await endExpiredOfferings();
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect((await offeringRow(fine)).ended_at).not.toBeNull();
    expect((await offeringRow(broken)).ended_at).toBeNull();

    const { data: dlq } = await admin.from("dead_letters").select("error_message").eq("source", "INTERNAL").contains("payload", { handler: "endExpiredOfferings", offering_id: broken });
    expect(dlq).toHaveLength(1);
    expect(dlq![0].error_message).toContain("강의 자동 종료 실패");
  });

  it("종료 취소: 이용권이 새 ADMIN_GRANT 행으로 재부여되고(옛 회수 행은 이력), 디스코드 역할도 다시 부여되며, 다시 자동 종료되지 않고, 직접 다시 종료할 수 있다", async () => {
    setDiscordRoleClientForTest(createMockDiscordRoleClient({ mode: "success" }));
    const off = await offering();
    const student = await profile({ linkDiscord: true });
    const enrollment = await paidEnrollment(off, student);

    await endExpiredOfferings();
    await runOutboxBatch();
    expect((await entitlements(enrollment.orderId)).every((e) => e.revoked_reason === "COURSE_ENDED")).toBe(true);

    const actor = (await admin.from("users").select("id").eq("role", "ADMIN").limit(1).single()).data!.id as string;
    const { data: count, error } = await admin.rpc("reopen_course_offering", { p_offering_id: off, p_actor: actor, p_actor_role: "ADMIN", p_reason: "vitest 종강일 입력 오류" });
    expect(error).toBeNull();
    expect(count).toBe(1);
    expect(await offeringRow(off)).toMatchObject({ ended_at: null, ended_by: null, end_note: null, manual_end: true });

    await runOutboxBatch();
    const after = await entitlements(enrollment.orderId);
    // 옛 회수 행 2개는 그대로 + 새 활성 행 2개(COURSE_ACCESS·DISCORD_ROLE, 직권 근거)
    expect(after).toHaveLength(4);
    expect(after.filter((e) => e.revoked_at !== null && e.revoked_reason === "COURSE_ENDED")).toHaveLength(2);
    const active = after.filter((e) => e.revoked_at === null);
    expect(active.map((e) => e.type).sort()).toEqual(["COURSE_ACCESS", "DISCORD_ROLE"]);
    expect(active.every((e) => e.grant_source === "ADMIN_GRANT")).toBe(true);

    // manual_end가 켜져 있어 크론이 다시 종료하지 않는다
    await endExpiredOfferings();
    expect((await offeringRow(off)).ended_at).toBeNull();

    // 관리자가 직접 다시 종료하면 새 이용권이 다시 회수된다
    const { error: endError } = await admin.rpc("end_course_offering", { p_offering_id: off, p_actor: actor, p_actor_role: "ADMIN", p_note: "vitest 다시 종료" });
    expect(endError).toBeNull();
    await runOutboxBatch();
    expect((await entitlements(enrollment.orderId)).every((e) => e.revoked_at !== null)).toBe(true);
  });

  it("종료 뒤 환불 사실(ORDER_REFUNDED)이 와도 이미 회수된 이용권의 회수 사유(COURSE_ENDED)는 덮어써지지 않는다", async () => {
    setDiscordRoleClientForTest(createMockDiscordRoleClient({ mode: "success" }));
    const off = await offering();
    const student = await profile({ linkDiscord: true });
    const enrollment = await paidEnrollment(off, student);
    await endExpiredOfferings();
    await runOutboxBatch();

    const { error } = await admin
      .from("outbox_messages")
      .insert({ topic: "ORDER_REFUNDED", payload: { order_id: enrollment.orderId, user_id: student, payment_event_id: enrollment.paymentId } });
    if (error) throw new Error(error.message);
    await runOutboxBatch();

    const rows = await entitlements(enrollment.orderId);
    expect(rows.every((e) => e.revoked_reason === "COURSE_ENDED")).toBe(true);
  });

  describe("대사 ⑪ 종료 처리 필요(OFFERING_END_PENDING)", () => {
    async function warnings(offeringId: string) {
      const { count } = await admin
        .from("dead_letters")
        .select("id", { count: "exact", head: true })
        .eq("source", "INTEGRITY")
        .eq("resolved", false)
        .contains("payload", { offering_id: offeringId, check: "OFFERING_END_PENDING" });
      return count ?? 0;
    }

    it("수동 설정은 종강 1일 뒤, 자동 설정은 3일 뒤부터 경고(중복 없음), 종강 전·종료된 강의는 경고 없음", async () => {
      const manual2d = await offering({ manual_end: true, ends_at: day(-2) });
      const manual12h = await offering({ manual_end: true, ends_at: new Date(Date.now() - 12 * 3_600_000).toISOString() });
      const auto2d = await offering({ ends_at: day(-2) });
      const auto4d = await offering({ ends_at: day(-4), opens_at: day(-6) });
      const future = await offering({ manual_end: true, ends_at: day(3), opens_at: day(-1) });

      await checkSystemIntegrity();
      await checkSystemIntegrity();

      expect(await warnings(manual2d)).toBe(1);
      expect(await warnings(manual12h)).toBe(0);
      expect(await warnings(auto2d)).toBe(0);
      expect(await warnings(auto4d)).toBe(1);
      expect(await warnings(future)).toBe(0);

      // 종료하면 경고 조건이 사라져 새 경고가 생기지 않는다(기존 경고는 관리자가 해결 처리)
      await admin.from("course_offerings").update({ ended_at: new Date().toISOString(), end_note: "vitest" }).eq("id", manual2d);
      await admin.from("dead_letters").delete().contains("payload", { offering_id: manual2d });
      await checkSystemIntegrity();
      expect(await warnings(manual2d)).toBe(0);
    });
  });
});
