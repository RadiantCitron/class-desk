import { createClient } from "@/lib/supabase/server";
import { runQuery } from "@/lib/commands/run-command";
import { one } from "@/lib/supabase/relations";
import { paymentEventLabel } from "@/lib/payment/ledger-view";

export type AdminPaymentsView = {
  rows: {
    id: string;
    timeText: string;
    orderHref: string | null;
    orderShort: string | null;
    email: string;
    courseText: string;
    label: string;
    amountText: string;
    method: string;
    providerText: string;
    rawJson: string;
  }[];
};

// 결제 원장(payment_events) 전체 조회 — 조건검색 없이 전부 출력. 관리자에게는 공개 가능한 모든 정보를 보여준다(raw_payload/metadata 포함) — 환불/실패 이력 추적,
// 이중결제 의심 건 확인(dead_letters DLQ와 함께) 등에 필요하다. ADMIN 전용(2026-09-18) — 원문이 그대로 노출되므로 매니저에게도 열지 않는다.
export async function loadAdminPayments(): Promise<AdminPaymentsView> {
  return runQuery({ command: "ADMIN_PAYMENTS_VIEW" }, async () => {
    const supabase = await createClient();
    // 2026-09-23 5단계(물품 추가): payment_events.user_id/purpose를 없앴다 — 누가·무엇을 샀는지는 orders를 통해서만 안다.
    const { data: events, error: eventsError } = await supabase
      .from("payment_events")
      .select(
        "id, event_type, provider, provider_transaction_id, provider_event_id, amount, currency, payment_method, metadata, raw_payload, created_at, order_id, orders(users(email), course_offerings(label, courses(name)))",
      )
      .order("created_at", { ascending: false })
      .limit(500);
    if (eventsError) console.error("결제 내역 조회 실패:", eventsError);

    return {
      rows: (events ?? []).map((event) => ({
        id: event.id,
        timeText: new Date(event.created_at).toLocaleString("ko-KR"),
        orderHref: event.order_id ? `/admin/orders/${event.order_id}` : null,
        orderShort: event.order_id ? `${event.order_id.slice(0, 8)}…` : null,
        email: one(one(event.orders)?.users)?.email ?? "",
        courseText: `${one(one(one(event.orders)?.course_offerings)?.courses)?.name ?? ""}${
        one(one(event.orders)?.course_offerings)?.label ? ` (${one(one(event.orders)?.course_offerings)?.label})` : ""
      }`,
        label: paymentEventLabel(event.event_type),
        amountText: `${event.amount.toLocaleString()} ${event.currency}`,
        method: event.payment_method ?? "-",
        providerText: `${event.provider}${event.provider_transaction_id ? ` / ${event.provider_transaction_id}` : ""}`,
        rawJson: JSON.stringify({ metadata: event.metadata, raw_payload: event.raw_payload }, null, 2),
      })),
    };
  });
}
