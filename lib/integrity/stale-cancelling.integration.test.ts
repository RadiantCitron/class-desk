import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { checkSystemIntegrity } from "./checks";

/**
 * 대사 ⑩(후속) — 폐강을 시작했는데 학생 처리를 방치한 개설강의를 경고한다.
 * 로컬 Supabase 필요(`npm run test:integration`). 외부 호출 없음. 읽기 전용 점검이라 상태는 바뀌지 않는다.
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

describe("대사 ⑩ 폐강 방치(CANCELLING_OFFERING_STALLED) — 통합", { timeout: 60_000 }, () => {
  let profiles: { id: string; authUserId: string }[] = [];
  let courseIds: string[] = [];
  let offeringIds: string[] = [];

  afterEach(async () => {
    // 경고만 치운다. 개설강의·주문은 FK로 지우지 않는다(잔여는 db:reset). 이 테스트 개설강의들은 끝에 폐강 완료로 닫아
    // 이후 대사가 계속 경고하지 않게 한다.
    for (const id of offeringIds) {
      await admin.from("dead_letters").delete().contains("payload", { offering_id: id });
      await admin.from("orders").update({ status: "CANCELLED", cancelled_at: new Date().toISOString() }).eq("course_offering_id", id).in("status", ["PENDING", "APPROVED"]);
    }
    for (const p of profiles) {
      await admin.from("users").update({ withdrawn_at: new Date().toISOString() }).eq("id", p.id);
      await admin.auth.admin.deleteUser(p.authUserId);
    }
    profiles = [];
    courseIds = [];
    offeringIds = [];
  });

  async function profile() {
    const email = `vitest-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (authError || !authUser.user) throw new Error(authError?.message);
    const { data: row, error } = await admin.from("users").insert({ auth_user_id: authUser.user.id, email, role: "STUDENT" }).select("id").single();
    if (error || !row) throw new Error(error?.message);
    profiles.push({ id: row.id as string, authUserId: authUser.user.id });
    return row.id as string;
  }

  // 폐강 중 개설강의 하나 + (선택) 승인된 결제 주문 한 건. 폐강 시작 시각을 daysAgo일 전으로 둔다.
  async function cancellingOffering(daysAgo: number, withOrder: boolean) {
    const actor = await profile();
    const { data: course, error: courseError } = await admin.from("courses").insert({ name: `vitest-stale-${randomUUID()}` }).select("id").single();
    if (courseError || !course) throw new Error(courseError?.message);
    courseIds.push(course.id as string);
    const { data: offering, error } = await admin
      .from("course_offerings")
      .insert({
        course_id: course.id,
        label: "stale",
        capacity: 5,
        remaining_seats: 5,
        price: 10000,
        location: "test",
        recruit_opens_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        opens_at: new Date(Date.now() + 86_400_000).toISOString(),
        status: "CANCELLING",
        status_reason: "vitest 폐강",
        status_changed_by: actor,
        status_changed_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
        grants: [],
        required_terms_types: [],
      })
      .select("id")
      .single();
    if (error || !offering) throw new Error(error?.message);
    offeringIds.push(offering.id as string);
    let orderId: string | null = null;
    if (withOrder) {
      const student = await profile();
      orderId = randomUUID();
      const { error: orderError } = await admin.from("orders").insert({
        id: orderId,
        user_id: student,
        course_offering_id: offering.id,
        status: "APPROVED",
        payment_status: "PAID",
        list_price: 10000,
        final_amount: 10000,
        approved_at: new Date().toISOString(),
        paid_at: new Date().toISOString(),
        payment_method: "CARD",
      });
      if (orderError) throw new Error(orderError.message);
    }
    return { offeringId: offering.id as string, orderId };
  }

  async function warnings(offeringId: string) {
    const { count } = await admin
      .from("dead_letters")
      .select("id", { count: "exact", head: true })
      .eq("source", "INTEGRITY")
      .eq("resolved", false)
      .contains("payload", { offering_id: offeringId, check: "CANCELLING_OFFERING_STALLED" });
    return count ?? 0;
  }

  it("폐강 시작 4일 경과 + 처리 안 된 수강생 → 경고 1건(두 번 돌려도 중복 없음)", async () => {
    const { offeringId } = await cancellingOffering(4, true);
    await checkSystemIntegrity();
    await checkSystemIntegrity();
    expect(await warnings(offeringId)).toBe(1);
    const { data } = await admin
      .from("dead_letters")
      .select("error_message")
      .eq("source", "INTEGRITY")
      .contains("payload", { offering_id: offeringId })
      .single();
    expect(data?.error_message).toContain("처리 안 된 수강생이 1명");
  });

  it("폐강 시작 1일 경과(기준 3일 전)는 경고하지 않는다", async () => {
    const { offeringId } = await cancellingOffering(1, true);
    await checkSystemIntegrity();
    expect(await warnings(offeringId)).toBe(0);
  });

  it("4일 경과라도 처리 안 된 수강생이 없으면 경고하지 않는다", async () => {
    const { offeringId } = await cancellingOffering(4, false);
    await checkSystemIntegrity();
    expect(await warnings(offeringId)).toBe(0);
  });

  it("학생을 처리하면(환불 없이 종료) 새 경고가 생기지 않는다", async () => {
    const { offeringId, orderId } = await cancellingOffering(4, true);
    const actor = (await admin.from("users").select("id").limit(1).single()).data!.id as string;
    const { error } = await admin.rpc("close_order_without_refund", {
      p_order_id: orderId,
      p_actor_id: actor,
      p_actor_role: "ADMIN",
      p_reason: "vitest 종료",
    });
    expect(error).toBeNull();
    await checkSystemIntegrity();
    expect(await warnings(offeringId)).toBe(0);
  });
});
