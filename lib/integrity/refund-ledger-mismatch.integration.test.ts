import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { checkSystemIntegrity } from "./checks";

/**
 * 대사 ③ — 환불 원장 합계와 주문 누적 환불액 비교(REFUND_LEDGER_MISMATCH).
 * 환불은 ①웹훅이 원장 기록 → ②드레인이 주문 누적액 갱신의 두 단계라, 그 사이에 다른 곳의 드레인이 대사를 돌려도
 * 오탐이 나면 안 된다(payment-chain 간헐 실패). 로컬 Supabase 필요, 외부 호출 없음.
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

describe("대사 ③ 환불 원장·주문 누적액 비교 — 통합", () => {
  let authUserId: string | null = null;
  let profileId: string | null = null;
  let orderId: string | null = null;

  afterEach(async () => {
    // payment_events·orders·products는 append-only·FK restrict라 지우지 않는다(잔여로 남김).
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

  // 결제 30000 중 15000이 주문에 반영된(PARTIALLY_REFUNDED) 주문 + 원장 REFUNDED 이벤트들.
  async function seed(ledgerAmounts: number[], ledgerAgeMinutes: number) {
    const email = `vitest-ledger-${randomUUID()}@example.com`;
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
      .insert({ name: `vitest-ledger-${randomUUID()}`, price: 30000 })
      .select("id")
      .single();
    if (productError || !product) throw new Error(`상품 실패: ${productError?.message}`);

    orderId = randomUUID();
    const paidAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const { error: orderError } = await admin.from("orders").insert({
      id: orderId,
      user_id: profileId,
      product_id: product.id,
      status: "APPROVED",
      payment_status: "PARTIALLY_REFUNDED",
      approved_at: paidAt,
      paid_at: paidAt,
      list_price: 30000,
      final_amount: 30000,
      payment_method: "CARD",
      refunded_amount: 15000,
    });
    if (orderError) throw new Error(`주문 실패: ${orderError.message}`);

    const createdAt = new Date(Date.now() - ledgerAgeMinutes * 60_000).toISOString();
    for (const amount of ledgerAmounts) {
      const { error } = await admin.from("payment_events").insert({
        provider: "TOSS",
        provider_event_id: `vitest-ledger-${randomUUID()}`,
        event_type: "REFUNDED",
        amount,
        currency: "KRW",
        order_id: orderId,
        created_at: createdAt,
      });
      if (error) throw new Error(`원장 REFUNDED 실패: ${error.message}`);
    }
    return orderId;
  }

  async function mismatchWarnings(oid: string) {
    const { data, error } = await admin
      .from("dead_letters")
      .select("payload, error_message")
      .eq("source", "INTEGRITY")
      .contains("payload", { order_id: oid, check: "REFUND_LEDGER_MISMATCH" });
    if (error) throw new Error(`dead_letters 조회 실패: ${error.message}`);
    return data ?? [];
  }

  it("방금 기록된 환불 이벤트 때문에 원장이 앞선 주문은 경고하지 않는다", async () => {
    const oid = await seed([15000, 15000], 0); // 원장 30000(방금) vs 주문 15000 — 아직 처리 중인 정상 상태
    await checkSystemIntegrity();
    expect(await mismatchWarnings(oid)).toHaveLength(0);
  });

  it("유예가 지난 뒤에도 원장과 주문이 다르면 경고한다", async () => {
    const oid = await seed([15000, 15000], 20); // 20분 전 — 유예(10분) 밖
    await checkSystemIntegrity();
    const rows = await mismatchWarnings(oid);
    // 1건 이상: 병렬로 도는 다른 파일의 대사와 동시에 실행되면 "이미 있는 미해결 경고" 조회와 INSERT 사이가 원자적이지
    // 않아 같은 경고가 2건 쌓일 수 있다(기존 중복 방지 방식의 한계 — 이 테스트의 관심사가 아님).
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.payload).toMatchObject({ ledger_sum: 30000, order_refunded_amount: 15000 });
  });

  it("원장과 주문이 일치하면 경고하지 않는다", async () => {
    const oid = await seed([15000], 20);
    await checkSystemIntegrity();
    expect(await mismatchWarnings(oid)).toHaveLength(0);
  });
});
