import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { checkSystemIntegrity } from "./checks";

/**
 * 60분 넘게 열린 환불 요청은 대사(checkSystemIntegrity)가 DLQ로 경고한다.
 * 로컬 Supabase 필요(`npm run test:integration`). 외부 호출 없음.
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

describe("대사 ⑧ 열린 환불 요청 경고(F10) — 통합", () => {
  let authUserId: string | null = null;
  let profileId: string | null = null;
  let orderId: string | null = null;

  afterEach(async () => {
    // payment_events·orders·products는 append-only·FK restrict라 지우지 않는다(잔여로 남김).
    // 지울 수 있는 것: 이 주문에 대한 대사 DLQ, 사용자(withdrawn 처리 + auth 삭제).
    if (orderId) {
      const { error } = await admin
        .from("dead_letters")
        .delete()
        .eq("source", "INTEGRITY")
        .contains("payload", { order_id: orderId });
      if (error) throw new Error(`dead_letters 정리 실패: ${error.message}`);
    }
    orderId = null;
    if (profileId) {
      const { error } = await admin
        .from("users")
        .update({ withdrawn_at: new Date().toISOString() })
        .eq("id", profileId);
      if (error) throw new Error(`users withdrawn 실패: ${error.message}`);
      profileId = null;
    }
    if (authUserId) {
      const { error } = await admin.auth.admin.deleteUser(authUserId);
      if (error) throw new Error(`auth 삭제 실패: ${error.message}`);
      authUserId = null;
    }
  });

  async function seedOrderWithRequest() {
    const email = `vitest-stale-refund-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(`auth 생성 실패: ${authError?.message}`);
    authUserId = authUser.user.id;
    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({ auth_user_id: authUserId, email, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(`프로필 실패: ${profileError?.message}`);
    profileId = profile.id;

    const { data: product, error: productError } = await admin
      .from("products")
      .insert({ name: `vitest-stale-refund-${randomUUID()}`, price: 20000 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`상품 실패: ${productError?.message}`);

    orderId = randomUUID();
    const { error: orderError } = await admin.from("orders").insert({
      id: orderId,
      user_id: profileId,
      product_id: product.id,
      status: "APPROVED",
      payment_status: "PAID",
      approved_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
      list_price: 20000,
      final_amount: 20000,
      payment_method: "CARD",
    });
    if (orderError) throw new Error(`주문 실패: ${orderError.message}`);

    const { error: reqError } = await admin.from("payment_events").insert({
      provider: "TOSS",
      provider_event_id: `vitest-stale-req-${randomUUID()}`,
      event_type: "REFUND_REQUESTED",
      amount: 20000,
      currency: "KRW",
      order_id: orderId,
      created_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });
    if (reqError) throw new Error(`환불 요청 행 실패: ${reqError.message}`);
    return orderId;
  }

  async function closeRequest(oid: string) {
    const { error } = await admin.from("payment_events").insert({
      provider: "TOSS",
      provider_event_id: `vitest-stale-fail-${randomUUID()}`,
      event_type: "REFUND_REQUEST_FAILED",
      amount: 20000,
      currency: "KRW",
      order_id: oid,
    });
    if (error) throw new Error(`닫기 행 실패: ${error.message}`);
  }

  async function staleWarnings(oid: string) {
    const { data, error } = await admin
      .from("dead_letters")
      .select("payload, error_message")
      .eq("source", "INTEGRITY")
      .contains("payload", { order_id: oid, check: "STALE_OPEN_REFUND_REQUEST" });
    if (error) throw new Error(`dead_letters 조회 실패: ${error.message}`);
    return data ?? [];
  }

  it("60분 넘게 열린 환불 요청은 대사가 DLQ로 경고한다", async () => {
    const oid = await seedOrderWithRequest();
    await checkSystemIntegrity();

    const rows = await staleWarnings(oid);
    // 1건 이상: 병렬로 도는 다른 파일의 대사와 동시에 실행되면 중복 방지(조회 후 INSERT)가 원자적이지 않아
    // 같은 경고가 2건 쌓일 수 있다 — 이 테스트의 관심사는 "경고가 생긴다"이다.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.error_message).toContain("환불 요청(REFUND_REQUESTED)이 60분 넘게");

    // 이후 대사가 이 주문을 계속 경고하지 않도록 요청을 닫아 둔다.
    await closeRequest(oid);
  });

  it("닫힌 환불 요청은 경고하지 않는다", async () => {
    const oid = await seedOrderWithRequest();
    await closeRequest(oid);
    await checkSystemIntegrity();

    expect(await staleWarnings(oid)).toHaveLength(0);
  });
});
