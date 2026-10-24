import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { loadRefundProposal, summarizeProposal } from "./refund-proposal";
import { CURRENT_REFUND_POLICY_ID } from "@/lib/shared/refund-policy";
import { todayKst } from "@/lib/shared/session-progress";

// 통합 테스트 — 로컬 Supabase 필요. : create_order가 정책 버전을 주문에 고정하고, 서버 로더가 실제 주문·회차로 약관 기준 제안을 계산한다.
// 주문이 생긴 개설강의는 delete_course_offering으로 지울 수 없어(신청 내역이 있으면 거부) 끝에 주문을 취소하고 개설강의를 직접 숨겨 회차를 비활성으로 돌린다.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다. .env.local을 확인하고 " +
      "`npm run db:start`로 로컬 Supabase를 띄운 뒤 다시 실행하세요.",
  );
}
const admin = createClient(url, key, { auth: { persistSession: false } });

const addDays = (days: number) => new Date(new Date(`${todayKst()}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
// 다른 실행이 남긴 회차와 시간대가 겹치지 않도록 하루 중 무작위 한 시각(1분짜리)을 쓴다.
const minute = Math.floor(Math.random() * 1300) + 10;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

describe("환불 정책 버전 고정과 제안 로더 — 통합", { timeout: 60_000 }, () => {
  let userIds: string[] = [];
  let offeringId: string | null = null;
  let courseId: string | null = null;
  let orderIds: string[] = [];

  afterEach(async () => {
    for (const id of orderIds) await admin.from("orders").update({ status: "CANCELLED", cancelled_at: new Date().toISOString() }).eq("id", id);
    if (offeringId && userIds[0]) {
      await admin
        .from("course_offerings")
        .update({ deleted_at: new Date().toISOString(), deleted_reason: "vitest 정리", deleted_by: userIds[0] })
        .eq("id", offeringId);
      await admin.from("course_sessions").update({ deactivated_at: new Date().toISOString(), deactivated_reason: "vitest 정리" }).eq("course_offering_id", offeringId).is("deactivated_at", null);
    }
    for (const id of userIds) await admin.from("users").update({ withdrawn_at: new Date().toISOString() }).eq("id", id);
    userIds = [];
    orderIds = [];
    offeringId = null;
  });

  async function ensureAdmin(): Promise<string> {
    const { data } = await admin.from("users").select("id").eq("role", "ADMIN").limit(1).maybeSingle();
    if (data?.id) return data.id;
    const { data: created } = await admin.from("users").insert({ auth_user_id: randomUUID(), email: `vitest-adm-${randomUUID()}@example.com`, role: "ADMIN" }).select("id").single();
    return created!.id;
  }

  async function setup(daysFromToday: number) {
    const { data: course, error: courseError } = await admin.from("courses").insert({ name: `vitest-refund-${randomUUID()}`, category: "TEST" }).select("id").single();
    expect(courseError).toBeNull();
    courseId = course!.id;
    // 개강이 아주 먼 미래인 개설강의로 신청(create_order는 개강 전에만 된다)한 뒤, 회차 날짜를 원하는 날로 옮긴다.
    const farYear = 6000 + Math.floor(Math.random() * 300);
    const adminId = await ensureAdmin();
    const { data: id, error } = await admin.rpc("create_course_offering", {
      p_course_id: courseId,
      p_label: "vitest-refund",
      p_capacity: 5,
      p_price: 10000,
      p_location: null,
      p_required_terms_types: [],
      p_grants: [{ type: "COURSE_ACCESS" }],
      p_recruit_opens_at: "2026-01-01T00:00:00Z",
      p_sessions: [{ date: `${farYear}-03-03`, start: hhmm(minute), end: hhmm(minute + 1) }],
      p_actor: adminId,
      p_actor_role: "ADMIN",
      p_auto_approve: false,
    });
    expect(error).toBeNull();
    offeringId = id as string;

    const { data: user, error: userError } = await admin
      .from("users")
      .insert({ auth_user_id: randomUUID(), email: `vitest-refund-${randomUUID()}@example.com`, role: "STUDENT" })
      .select("id")
      .single();
    expect(userError).toBeNull();
    userIds.push(user!.id);

    const { data: orderId, error: orderError } = await admin.rpc("create_order", {
      p_user_id: user!.id,
      p_course_offering_id: offeringId,
      p_product_id: null,
      p_terms_ids: null,
      p_refund_policy_version: CURRENT_REFUND_POLICY_ID,
    });
    expect(orderError).toBeNull();
    orderIds.push(orderId as string);

    // 회차 행 날짜 직접 수정은 DB 트리거로 차단되므로 새 회차 insert 후 임시 먼 미래 회차 비활성화
    await admin.from("course_sessions").insert({
      course_offering_id: offeringId,
      session_date: addDays(daysFromToday),
      start_time: hhmm(minute),
      end_time: hhmm(minute + 1),
    });
    await admin
      .from("course_sessions")
      .update({ deactivated_at: new Date().toISOString(), deactivated_reason: "vitest 날짜 교체" })
      .eq("course_offering_id", offeringId)
      .like("session_date", "6%");

    const now = new Date().toISOString();
    const { error: payError } = await admin
      .from("orders")
      .update({ status: "APPROVED", approved_at: now, payment_status: "PAID", paid_at: now, payment_method: "CARD" })
      .eq("id", orderId);
    expect(payError).toBeNull();
    return orderId as string;
  }

  it("create_order가 현재 정책 버전을 주문에 고정하고, 개강 3일 전이면 70%를 제안한다", async () => {
    const orderId = await setup(3);
    const { data: order } = await admin.from("orders").select("refund_policy_version").eq("id", orderId).single();
    expect(order?.refund_policy_version).toBe(CURRENT_REFUND_POLICY_ID);

    const proposal = await loadRefundProposal(orderId, 10_000);
    expect(proposal).toMatchObject({ eligible: true, stage: "BEFORE_START", amount: 7_000, daysBefore: 3, policyId: CURRENT_REFUND_POLICY_ID, policyNote: null });
    expect(summarizeProposal(proposal)).toMatchObject({ amount: 7_000, stage: "BEFORE_START", ratio: { n: 7, d: 10 }, penalty: null });
  });

  it("개강 당일 하루짜리는 불가, 환불 가능액이 작으면 그 값으로 제한, 버전 null(옛 주문)이면 레거시 버전으로 계산하고 밝힌다", async () => {
    const orderId = await setup(0);
    expect(await loadRefundProposal(orderId, 10_000)).toMatchObject({ eligible: false, stage: "NOT_ALLOWED", amount: 0 });

    // 10일 후 회차 insert 후 기존 회차 비활성화
    await admin.from("course_sessions").insert({
      course_offering_id: offeringId!,
      session_date: addDays(10),
      start_time: hhmm(minute),
      end_time: hhmm(minute + 1),
    });
    await admin
      .from("course_sessions")
      .update({ deactivated_at: new Date().toISOString(), deactivated_reason: "vitest 10일 후 교체" })
      .eq("course_offering_id", offeringId!)
      .is("deactivated_at", null)
      .neq("session_date", addDays(10));

    expect((await loadRefundProposal(orderId, 4_000))?.amount).toBe(4_000);

    await admin.from("orders").update({ refund_policy_version: null }).eq("id", orderId);
    const legacy = await loadRefundProposal(orderId, 10_000);
    expect(legacy?.amount).toBe(10_000);
    expect(legacy?.policyNote).toContain("기록되지 않은");
  });

  it("할인받은 다회차의 개강 후 구간에서는 위약금이 빠진다(서버 계산도 같은 함수)", async () => {
    const orderId = await setup(0);
    // 회차를 4개로 늘려 첫 회차를 오늘로(개강 당일, 1/4 경과 → 2/3), 정가가 지불액보다 크면 위약금 10%
    for (const d of [7, 14, 21]) {
      await admin.from("course_sessions").insert({ course_offering_id: offeringId!, session_date: addDays(d), start_time: hhmm(minute), end_time: hhmm(minute + 1) });
    }
    expect((await loadRefundProposal(orderId, 10_000))?.amount).toBe(6_666);
    await admin.from("orders").update({ list_price: 12_000 }).eq("id", orderId);
    const discounted = await loadRefundProposal(orderId, 10_000);
    expect(discounted?.amount).toBe(5_666);
    expect(discounted?.penalty).toEqual({ n: 1, d: 10 });
  });

  it("제안 대상이 아닌 주문(결제 전·승인 전)은 null, 모르는 정책 버전은 던진다", async () => {
    const orderId = await setup(3);
    await admin.from("orders").update({ refund_policy_version: "nope" }).eq("id", orderId);
    await expect(loadRefundProposal(orderId, 10_000)).rejects.toThrow("알 수 없는 환불 정책 버전");
    expect(summarizeProposal(null, "x")).toEqual({ error: "x" });

    await admin.from("orders").update({ refund_policy_version: CURRENT_REFUND_POLICY_ID, payment_status: "UNPAID", paid_at: null, payment_method: null }).eq("id", orderId);
    expect(await loadRefundProposal(orderId, 10_000)).toBeNull();
  });
});
