import { createAdminClient } from "@/lib/supabase/admin";

// 디지털 파일 다운로드 여부 판정: 이 주문으로 발급된 SOURCE_DOWNLOAD 이용권을 한 번이라도 내려받았는가.
// 2026-10-07부터 환불을 막는 데 쓰지 않는다 — 관리자 주문 화면 경고와 환불 감사 기록(digitalConsumed)용이다
// (10-04 R-5에서는 환불 차단 가드였다).
// 이용권 모듈 테이블(entitlements·entitlement_uses)을 읽는 판정이라 결제 모듈(lib/payment)이 아니라 CS 가드에 둔다 —
// CS 가드는 여러 모듈을 읽어도 되는 유일한 자리다(R1 읽기 예외, CS_READ_ONLY_EXCEPTIONS). 2026-10-07에
// lib/payment/index.ts에서 옮겼다.
//
// 조회가 실패하면 "안 받았다"로 보지 않고 던진다 — 오류를 '없음'으로 처리하면 경고·기록이 틀린다(fail-closed).
export async function hasConsumedDigitalProduct(orderId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data: entitlements, error: entitlementsError } = await admin
    .from("entitlements")
    .select("id")
    .eq("order_id", orderId)
    .eq("type", "SOURCE_DOWNLOAD");
  if (entitlementsError) {
    throw new Error(`다운로드 이용권 조회 실패: ${entitlementsError.message}`);
  }
  if (!entitlements || entitlements.length === 0) return false;

  const { data: uses, error: usesError } = await admin
    .from("entitlement_uses")
    .select("id")
    .in("entitlement_id", entitlements.map((e) => e.id))
    .limit(1);
  if (usesError) {
    throw new Error(`다운로드 사용 기록 조회 실패: ${usesError.message}`);
  }
  return (uses?.length ?? 0) > 0;
}
