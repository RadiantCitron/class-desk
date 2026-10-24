import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { loadOpenRefundRequest } from "./refund-request";
import { CURRENT_REFUND_POLICY_ID } from "@/lib/shared/refund-policy";

// 통합 테스트 — 로컬 Supabase 필요. : 학생 환불 신청·관리자 거절(DB 함수를 서버 액션과 같은 인자 이름으로 호출)과
// 서버 쪽 「열린 신청」 로더. 신청은 사건만 남기고 환불은 하지 않는다(주문 상태 불변)는 점도 확인한다.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다. .env.local을 확인하고 " +
      "`npm run db:start`로 로컬 Supabase를 띄운 뒤 다시 실행하세요.",
  );
}
const admin = createClient(url, key, { auth: { persistSession: false } });
const farYear = 6400 + Math.floor(Math.random() * 300);
const minute = Math.floor(Math.random() * 1300) + 10;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

describe("수강생 환불 신청·거절 — 통합", { timeout: 60_000 }, () => {
  let userIds: string[] = [];
  let offeringIds: string[] = [];
  let seq = 0;
  let orderIds: string[] = [];

  afterEach(async () => {
    for (const id of orderIds) await admin.from("orders").update({ status: "CANCELLED", cancelled_at: new Date().toISOString() }).eq("id", id);
    for (const id of offeringIds) {
      if (!userIds[0]) break;
      await admin.from("course_offerings").update({ deleted_at: new Date().toISOString(), deleted_reason: "vitest 정리", deleted_by: userIds[0] }).eq("id", id);
      await admin.from("course_sessions").update({ deactivated_at: new Date().toISOString(), deactivated_reason: "vitest 정리" }).eq("course_offering_id", id).is("deactivated_at", null);
    }
    for (const id of userIds) await admin.from("users").update({ withdrawn_at: new Date().toISOString() }).eq("id", id);
    userIds = [];
    orderIds = [];
    offeringIds = [];
  });

  async function setup(method: "CARD" | "BANK_TRANSFER" = "CARD") {
    const { data: adminUser } = await admin.from("users").select("id").eq("role", "ADMIN").limit(1).single();
    const adminId = adminUser!.id;
    const { data: course } = await admin.from("courses").insert({ name: `vitest-rr-${randomUUID()}`, category: "TEST" }).select("id").single();
    const { data: id, error } = await admin.rpc("create_course_offering", {
      p_course_id: course!.id,
      p_label: "vitest-rr",
      p_capacity: 5,
      p_price: 10000,
      p_location: null,
      p_required_terms_types: [],
      p_grants: [{ type: "COURSE_ACCESS" }],
      p_recruit_opens_at: "2026-01-01T00:00:00Z",
      p_sessions: [{ date: `${farYear}-${String(1 + (seq++ % 12)).padStart(2, "0")}-03`, start: hhmm(minute), end: hhmm(minute + 1) }],
      p_actor: adminId,
      p_actor_role: "ADMIN",
      p_auto_approve: false,
    });
    expect(error).toBeNull();
    const offeringId = id as string;
    offeringIds.push(offeringId);
    const mkUser = async () => {
      const { data } = await admin.from("users").insert({ auth_user_id: randomUUID(), email: `vitest-rr-${randomUUID()}@example.com`, role: "STUDENT" }).select("id").single();
      userIds.push(data!.id);
      return data!.id as string;
    };
    const studentId = await mkUser();
    const otherId = await mkUser();
    const { data: orderId } = await admin.rpc("create_order", {
      p_user_id: studentId, p_course_offering_id: offeringId, p_product_id: null, p_terms_ids: null, p_refund_policy_version: CURRENT_REFUND_POLICY_ID,
    });
    orderIds.push(orderId as string);
    const now = new Date().toISOString();
    await admin.from("orders").update({ status: "APPROVED", approved_at: now, payment_status: "PAID", paid_at: now, payment_method: method }).eq("id", orderId);
    return { orderId: orderId as string, studentId, otherId };
  }

  it("신청 → 열린 신청으로 읽힘(주문 상태 불변) → 거절 → 닫힘 → 다시 신청 → 새 신청이 열림", async () => {
    const { orderId, studentId } = await setup();
    expect(await loadOpenRefundRequest(orderId)).toBeNull();

    const first = await admin.rpc("request_order_refund", {
      p_order_id: orderId, p_user_id: studentId, p_reason: "개인 사정", p_proposal: { amount: 10000, stage: "BEFORE_START" },
    });
    expect(first.error).toBeNull();
    const open = await loadOpenRefundRequest(orderId);
    expect(open?.id).toBe(first.data);
    expect(open?.payload).toMatchObject({ reason: "개인 사정", proposal: { amount: 10000 } });
    const { data: order } = await admin.from("orders").select("status, payment_status, refunded_amount").eq("id", orderId).single();
    expect(order).toMatchObject({ status: "APPROVED", payment_status: "PAID", refunded_amount: 0 }); // 신청만 — 환불·종료 없음

    const dup = await admin.rpc("request_order_refund", { p_order_id: orderId, p_user_id: studentId, p_reason: "또", p_proposal: {} });
    expect(dup.error?.message).toContain("이미 환불을 신청했습니다");

    const admins = await admin.rpc("reject_order_refund_request", { p_order_id: orderId, p_actor_id: studentId, p_actor_role: "STUDENT", p_reason: "x" });
    expect(admins.error?.message).toContain("관리자만");
    const rejected = await admin.rpc("reject_order_refund_request", { p_order_id: orderId, p_actor_id: userIds[0], p_actor_role: "ADMIN", p_reason: "개강 임박" });
    expect(rejected.error).toBeNull();
    expect(await loadOpenRefundRequest(orderId)).toBeNull();

    const again = await admin.rpc("request_order_refund", { p_order_id: orderId, p_user_id: studentId, p_reason: "다시", p_proposal: {} });
    expect(again.error).toBeNull();
    expect((await loadOpenRefundRequest(orderId))?.id).toBe(again.data);
  });

  it("남의 주문·카드가 아닌 결제는 신청되지 않는다", async () => {
    const { orderId, otherId } = await setup();
    const notMine = await admin.rpc("request_order_refund", { p_order_id: orderId, p_user_id: otherId, p_reason: "남의 것", p_proposal: {} });
    expect(notMine.error?.message).toContain("내 신청 건이 아닙니다");

    const bank = await setup("BANK_TRANSFER");
    const res = await admin.rpc("request_order_refund", { p_order_id: bank.orderId, p_user_id: bank.studentId, p_reason: "계좌이체", p_proposal: {} });
    expect(res.error?.message).toContain("카드로 결제한 건만");
  });

  it("A-2: 신청 시점 제안 스냅샷이 승인 기본값으로 고정되며 시간이 지나 구간이 변해도 유지된다", async () => {
    const { orderId, studentId } = await setup();
    // 3일 전 70% 시점에 신청
    const proposalAtRequest = {
      policyId: CURRENT_REFUND_POLICY_ID,
      stage: "BEFORE_START",
      eligible: true,
      amount: 7000,
      daysBefore: 3,
      ratio: { n: 7, d: 10 },
      penalty: null,
    };
    const reqRes = await admin.rpc("request_order_refund", {
      p_order_id: orderId,
      p_user_id: studentId,
      p_reason: "3일 전 신청",
      p_proposal: proposalAtRequest,
    });
    expect(reqRes.error).toBeNull();

    const open = await loadOpenRefundRequest(orderId);
    expect(open).not.toBeNull();

    const { readRequestSnapshot, buildAmountDefault } = await import("./refund-proposal");
    const snapshot = readRequestSnapshot(open?.payload);
    expect(snapshot?.proposal).toMatchObject({ amount: 7000, daysBefore: 3, ratio: { n: 7, d: 10 } });

    // 시간이 지나 환불 가능액(10,000) 잔액 기준 기본값은 7,000원 partial로 고정
    const amountDef = buildAmountDefault(snapshot, 10000);
    expect(amountDef).toEqual({ mode: "partial", amount: 7000 });

    // 스냅샷 금액과 다른 결정액 비교
    const snapshotAmount = snapshot?.proposal?.amount ?? null;
    const decidedSame = 7000;
    const decidedDifferent = 5000;
    expect(decidedSame !== snapshotAmount).toBe(false);
    expect(decidedDifferent !== snapshotAmount).toBe(true);
  });
});

