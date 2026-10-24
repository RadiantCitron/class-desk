import { createAdminClient } from "@/lib/supabase/admin";

// 주문 모듈의 이벤트 핸들러 — 결제 모듈의 사실(PAYMENT_SUCCEEDED/PAYMENT_REFUNDED)에 반응한다
// "이 결제를 받아도 되는 주문인가" 판단과 주문 반영은 전부
// DB 함수(on_payment_succeeded/on_payment_refunded)가 행 잠금 안에서 한다 — 여기는 페이로드에서
// 결제 이벤트 번호를 꺼내 넘기기만 한다. 연동표(lib/wiring/outbox.ts) 밖에서 import 금지(R3).

function requireString(payload: Record<string, unknown>, key: string, topic: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${topic} 페이로드에 ${key}가 없습니다.`);
  }
  return value;
}

function requireNumber(payload: Record<string, unknown>, key: string, topic: string): number {
  const value = payload[key];
  if (typeof value !== "number") {
    throw new Error(`${topic} 페이로드에 ${key}가 없습니다.`);
  }
  return value;
}

// payment_method는 null일 수 있다(record_payment_event의 p_payment_method: string | null) —
// 결제 성공 이벤트에도 이 값이 그대로 실려 올 수 있으므로, 필수로 요구하면 정상 결제도 영원히 실패한다.
function optionalString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export async function onPaymentSucceeded(payload: Record<string, unknown>) {
  const admin = createAdminClient();
  // payment_events를 이 함수도, 부르는 DB 함수도 읽지 않는다. 결제 사실
  // 페이로드에 실려 온 값을 그대로 전달한다.
  const { error } = await admin.rpc("on_payment_succeeded", {
    p_payment_event_id: requireString(payload, "payment_event_id", "PAYMENT_SUCCEEDED"),
    p_order_id: requireString(payload, "order_id", "PAYMENT_SUCCEEDED"),
    p_provider: requireString(payload, "provider", "PAYMENT_SUCCEEDED"),
    p_amount: requireNumber(payload, "amount", "PAYMENT_SUCCEEDED"),
    p_currency: requireString(payload, "currency", "PAYMENT_SUCCEEDED"),
    p_payment_method: optionalString(payload, "payment_method"),
    p_metadata: (payload.metadata as object | undefined) ?? {},
  });
  if (error) {
    throw new Error(`결제 성공 반영 실패: ${error.message}`);
  }
}

export async function onPaymentRefunded(payload: Record<string, unknown>) {
  const admin = createAdminClient();
  const { error } = await admin.rpc("on_payment_refunded", {
    p_payment_event_id: requireString(payload, "payment_event_id", "PAYMENT_REFUNDED"),
    p_order_id: requireString(payload, "order_id", "PAYMENT_REFUNDED"),
    p_provider: requireString(payload, "provider", "PAYMENT_REFUNDED"),
    p_amount: requireNumber(payload, "amount", "PAYMENT_REFUNDED"),
    p_currency: requireString(payload, "currency", "PAYMENT_REFUNDED"),
    // 구버전 사실(cause·reason 없음)도 처리해야 하므로 선택 값이다.
    p_cause: typeof payload.cause === "string" ? payload.cause : null,
    p_reason: typeof payload.reason === "string" ? payload.reason : null,
    p_keep_order: typeof payload.keep_order === "boolean" ? payload.keep_order : false,
  });
  if (error) {
    throw new Error(`환불 반영 실패: ${error.message}`);
  }
}

export async function cancelOrdersForWithdrawnUser(payload: Record<string, unknown>) {
  const userId = payload.user_id;
  if (typeof userId !== "string" || userId === "") {
    throw new Error("USER_WITHDRAWN 페이로드에 user_id가 없습니다.");
  }
  const admin = createAdminClient();
  const { error } = await admin.rpc("cancel_orders_for_withdrawn_user", { p_user_id: userId });
  if (error) {
    throw new Error(`탈퇴 회원 주문 취소 실패: ${error.message}`);
  }
}
