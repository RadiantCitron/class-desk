import { createAdminClient } from "@/lib/supabase/admin";
import { one } from "@/lib/supabase/relations";
import { fetchAllPages, fetchInChunks } from "./paging";
import { RESULT_EVENT_TYPES, resultForAttempt } from "@/lib/payment/attempt-result";
import { findOpenRefundRequest, STALE_OPEN_REFUND_MINUTES } from "@/lib/payment/ledger-view";
import { isCommandCode } from "@/lib/commands/registry";

// 시스템 전반의 데이터 무결성을 점검하는 "체크" 계층 — 실행/인증/감사와 나란한 관심사로
// 아웃박스 러너(lib/outbox/drain.ts)가 배치 끝마다 호출한다(예전엔 관리자 액션마다 요청 경로에서 동기로 돌았다, 2026-09-12~2026-09-25). 별도
// 프로그램(cron/데몬)을 새로 띄우지 않고, "관리자가 뭔가를 실행할 때 하는 김에" 가볍게
// 훑어보는 방식이다(2026-09-12 — Next.js Proxy가 아니라 이 방식을 택했다).
//
// 여기서 발견한 문제는 액션을 실패시키지 않는다 — 이 액션과 무관한 시스템 전체의 상태를
// 보는 것이므로, 발견되면 기존 DLQ(dead_letters)에 경고로 남기고 관리자가 나중에
// 확인하게 한다(자동으로 뭔가를 취소/반려하지 않음 — 정책 미정, "찾아서 보여주기"까지만).
export async function checkSystemIntegrity(): Promise<void> {
  try {
    const admin = createAdminClient();
    // 미해결 경고를 한 번에 읽어 두고, 점검들이 후보마다 "이미 있는 경고인가"를 조회하지 않게 한다.
    const open = await loadOpenIntegrityWarnings(admin);
    // 점검 하나가 실패해도 나머지는 계속 돈다(예전엔 예외 하나가 뒤 점검 전부를 중단시켰다).
    const checks: Array<[string, () => Promise<void>]> = [
      ["checkStalePendingOrders", checkStalePendingOrders],
      ["checkPaidEventsWithUnpaidOrders", checkPaidEventsWithUnpaidOrders],
      ["checkRefundLedgerMismatch", () => checkRefundLedgerMismatch(open)],
      ["checkPaidOrdersWithoutEntitlements", () => checkPaidOrdersWithoutEntitlements(open)],
      ["checkWaivedOrdersWithoutEntitlements", () => checkWaivedOrdersWithoutEntitlements(open)],
      ["checkStaleCancellingOfferings", () => checkStaleCancellingOfferings(open)],
      ["checkEndPendingOfferings", () => checkEndPendingOfferings(open)],
      ["checkOfferingScheduleDrift", () => checkOfferingScheduleDrift(open)],
      ["checkRevokedUsersWithActiveEntitlements", () => checkRevokedUsersWithActiveEntitlements(open)],
      ["checkStaleApprovedUnpaidOrders", checkStaleApprovedUnpaidOrders],
      ["checkUnresolvedConfirms", () => checkUnresolvedConfirms(open)],
      ["checkStaleOpenRefundRequests", () => checkStaleOpenRefundRequests(open)],
      ["checkUnknownSwitchTargets", () => checkUnknownSwitchTargets(open)],
      ["checkWithdrawnUnrefundedOrders", () => checkWithdrawnUnrefundedOrders(open)],
      ["checkAuditGateClosed", () => checkAuditGateClosed(open)],
      ["checkEndedOfferingOpenRefundRequests", () => checkEndedOfferingOpenRefundRequests(open)],
      ["checkOfferingLedgerDrift", () => checkOfferingLedgerDrift(open)],
    ];
    for (const [name, run] of checks) {
      try {
        await run();
      } catch (err) {
        console.error(`무결성 점검 실패(${name}):`, err);
      }
    }
  } catch (err) {
    // 체크 로직 자체의 실패가 원래 하려던 관리자 액션을 막으면 안 된다 — 로그만 남긴다.
    console.error("무결성 점검 실패:", err);
  }
}

// ---- 공용: 미해결 경고 집합 -------------------------------------------------------------------
// 예전에는 점검마다 후보 하나하나에 대해 "같은 경고가 이미 미해결로 있나"를 dead_letters에서 다시 조회했다
// (후보 수만큼 왕복). 이제 점검 시작 때 미해결 INTEGRITY 경고를 한 번에 읽어 (점검 종류, 주문/사용자) 키
// 집합으로 들고 있고, 새로 넣은 경고도 집합에 추가한다. 조회 후 INSERT가 원자적이지 않은 점(동시에 도는 두
// 점검이 같은 경고를 중복 적재할 수 있음)은 예전과 같다.
type Admin = ReturnType<typeof createAdminClient>;
type OpenWarnings = Set<string>;

const warningKey = (check: string, kind: "order" | "user" | "switch" | "offering", id: string) => `${check}|${kind}|${id}`;

async function loadOpenIntegrityWarnings(admin: Admin): Promise<OpenWarnings> {
  const rows = await fetchAllPages<{ id: string; payload: Record<string, unknown> | null }>((from, to) =>
    admin
      .from("dead_letters")
      .select("id, payload")
      .eq("source", "INTEGRITY")
      .eq("resolved", false)
      .order("id")
      .range(from, to),
  );
  const open: OpenWarnings = new Set();
  for (const row of rows) {
    const payload = row.payload;
    if (!payload || typeof payload.check !== "string") continue;
    if (typeof payload.order_id === "string") open.add(warningKey(payload.check, "order", payload.order_id));
    if (typeof payload.user_id === "string") open.add(warningKey(payload.check, "user", payload.user_id));
    if (typeof payload.switch_id === "string") open.add(warningKey(payload.check, "switch", payload.switch_id));
    if (typeof payload.offering_id === "string") open.add(warningKey(payload.check, "offering", payload.offering_id));
  }
  return open;
}

async function raiseWarning(
  admin: Admin,
  open: OpenWarnings,
  key: string,
  row: { payload: Record<string, unknown>; error_message: string },
) {
  if (open.has(key)) return;
  await admin.from("dead_letters").insert({ source: "INTEGRITY", ...row });
  open.add(key);
}

// 수강신청을 취소할 수 있어도 영원히 PENDING 상태로 남는 것은 진짜 결함이다: create_order()이 신청 즉시
// remaining_seats를 차감하므로, 관리자가 승인/반려를 안 하고 방치하면 그 좌석이 영구히
// 잠긴다. 여기서는 자동으로 취소하지 않고, 발견해서 DLQ에 경고만 남긴다.
const STALE_PENDING_DAYS = 7;

async function checkStalePendingOrders() {
  const admin = createAdminClient();

  const staleCutoff = new Date(Date.now() - STALE_PENDING_DAYS * 86_400_000).toISOString();
  const { data: staleOrders } = await admin
    .from("orders")
    .select("id, created_at")
    .eq("status", "PENDING")
    .lt("created_at", staleCutoff);

  if (!staleOrders || staleOrders.length === 0) return;

  for (const order of staleOrders) {
    // 관리자가 실행할 때마다 이 체크가 도는 구조라, 이미 떠 있는 미해결 경고가 있으면
    // 중복으로 쌓지 않는다(관리자가 해결 처리하기 전까진 한 건만 유지).
    const { data: existing } = await admin
      .from("dead_letters")
      .select("id")
      .eq("source", "INTEGRITY")
      .eq("resolved", false)
      .contains("payload", { order_id: order.id })
      // limit(1) 없이 maybeSingle()을 쓰면 같은 경고가 2건 이상일 때 에러로 null이 돌아와
      // "없음"으로 판단하고 드레인마다 1건씩 더 쌓인다.
      .limit(1)
      .maybeSingle();

    if (existing) continue;

    const daysSinceApplied = Math.floor(
      (Date.now() - new Date(order.created_at).getTime()) / 86_400_000,
    );

    await admin.from("dead_letters").insert({
      source: "INTEGRITY",
      payload: { order_id: order.id, created_at: order.created_at },
      error_message: `PENDING 상태로 ${daysSinceApplied}일째 방치된 신청 발견(기준: ${STALE_PENDING_DAYS}일) — 승인/반려가 필요합니다. 방치되는 동안 좌석 1자리가 계속 잠겨 있습니다.`,
    });
  }
}

// 대사 ② — 결제 원장(payment_events)과 주문 장부(orders.payment_status)를 맞춰 본다.
// 결제 성공 기록이 있는데 주문이 10분이 넘도록 미결제면, 결제 사실이 주문
// 핸들러까지 못 갔거나(러너 정지) 핸들러가 결론 없이 끝난 것이다. 주문 핸들러가 이미 판단해서 DLQ에
// 올린 건(금액 불일치·이중결제·취소된 주문)과 러너 실패 DLQ는 payment_event_id가 같은 **미해결** DLQ
// 행이 있으므로 건너뛴다 — 아무도 모르는 불일치만 새로 알린다.
// S-3(2026-10-08): 예전엔 해결된 DLQ 행도 「있음」으로 쳐서, 결제 진행 중 폐강·취소로 생긴 고아 결제를
// 관리자가 환불 없이 해결 처리하면 다시는 잡히지 않았다. 이제 미해결 행만 보고, 대신 원장 잔액
// (결제 성공 합 − 환불 합)이 0 이하인 주문은 건너뛴다 — 환불로 정리된 고아 결제는 주문이 UNPAID로
// 남아도(환불 웹훅이 「이미 취소된 주문」으로 주문을 안 바꿈) 경고하지 않는다.
const PAID_EVENT_GRACE_MINUTES = 10;
const PAID_EVENT_LOOKBACK_DAYS = 30;

async function checkPaidEventsWithUnpaidOrders() {
  const admin = createAdminClient();

  const graceCutoff = new Date(Date.now() - PAID_EVENT_GRACE_MINUTES * 60_000).toISOString();
  const lookbackCutoff = new Date(Date.now() - PAID_EVENT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data: events } = await admin
    .from("payment_events")
    .select("id, order_id, created_at, orders(payment_status, status)")
    .eq("event_type", "PAYMENT_SUCCEEDED")
    .lt("created_at", graceCutoff)
    .gte("created_at", lookbackCutoff);

  const candidates = (events ?? []).filter((event) => one(event.orders)?.payment_status === "UNPAID");
  if (candidates.length === 0) return;

  // 후보 주문의 원장 잔액을 한 번에 계산한다(getRefundableAmount와 같은 기준: 성공 − 환불).
  const orderIds = [...new Set(candidates.map((event) => event.order_id as string))];
  const ledger = await fetchInChunks<{ order_id: string; event_type: string; amount: number | null }>(
    orderIds,
    (chunk, from, to) =>
      admin
        .from("payment_events")
        .select("order_id, event_type, amount")
        .in("order_id", chunk)
        .in("event_type", ["PAYMENT_SUCCEEDED", "REFUNDED"])
        .order("id")
        .range(from, to),
  );
  const netByOrder = new Map<string, number>();
  for (const row of ledger) {
    const sign = row.event_type === "REFUNDED" ? -1 : 1;
    netByOrder.set(row.order_id, (netByOrder.get(row.order_id) ?? 0) + sign * (row.amount ?? 0));
  }

  for (const event of candidates) {
    const net = netByOrder.get(event.order_id) ?? 0;
    if (net <= 0) continue;

    const { data: existing } = await admin
      .from("dead_letters")
      .select("id")
      .eq("resolved", false)
      .contains("payload", { payment_event_id: event.id })
      .limit(1)
      .maybeSingle();

    if (existing) continue;

    const orderStatus = one(event.orders)?.status;
    const orphanHint =
      orderStatus === "CANCELLED" || orderStatus === "REJECTED"
        ? ` 주문이 ${orderStatus}라 결제 진행 중 폐강·취소로 생긴 고아 결제로 보입니다 — /admin/orders/${event.order_id}에서 환불하세요(미환불 ${net.toLocaleString()}원).`
        : " 아웃박스 처리 상태를 확인하세요.";

    await admin.from("dead_letters").insert({
      source: "INTEGRITY",
      payload: { payment_event_id: event.id, order_id: event.order_id },
      error_message: `결제 성공 기록이 있는데 주문이 ${PAID_EVENT_GRACE_MINUTES}분 넘게 미결제(UNPAID) 상태 — 결제 사실이 주문에 반영되지 않았습니다.${orphanHint} payment_event_id=${event.id}`,
    });
  }
}

// 대사 ③ — 환불 원장(payment_events)과 orders.refunded_amount(누적액, 20260925140100
// partial_refund)가 맞는지 맞춰 본다. **주의**: payment_events.event_type의 실제 저장값은
// 'REFUNDED'다 — 'PAYMENT_REFUNDED'는 아웃박스 토픽 이름이지 원장 event_type이 아니다
// (record_payment_event()의 `elsif p_event_type = 'REFUNDED' then ... values ('PAYMENT_REFUNDED', ...)`,
// 20260925110000_payment_order_separation.sql 근거 — 확인 완료, 2026-09-25). 'PAYMENT_REFUNDED'로
// 조회하면 항상 0건이 나와 모든 환불 주문이 거짓 경보 대상이 된다. 부분 환불을 여러 번 거친
// 주문에서 on_payment_refunded()가 누적에 실패했거나 건너뛴 이벤트가 있으면 여기서 잡힌다.
//
// 유예: 환불은 ①웹훅이 원장에 REFUNDED를 기록 → ②드레인이 orders.refunded_amount를
// 갱신하는 두 단계라, 그 사이에는 원장 합계가 주문 누적액보다 큰 것이 정상이다. 다른 곳의 드레인이 그 창에
// 대사를 돌리면 오탐이 났다(payment-chain C2 간헐 실패). 그래서 **유예(PAID_EVENT_GRACE_MINUTES) 안에 생긴
// REFUNDED 이벤트가 하나라도 있는 주문은 건너뛴다** — 아직 처리 중일 수 있다. 유예가 지나도 다르면 경고한다.
async function checkRefundLedgerMismatch(open: OpenWarnings) {
  const admin = createAdminClient();

  const graceCutoff = new Date(Date.now() - PAID_EVENT_GRACE_MINUTES * 60_000).toISOString();

  const orders = await fetchAllPages<{ id: string; refunded_amount: number }>((from, to) =>
    admin.from("orders").select("id, refunded_amount").gt("refunded_amount", 0).order("id").range(from, to),
  );
  // 주문마다 조회하지 않고 100개씩 묶어 한 번에 읽는다.
  const events = await fetchInChunks<{ id: string; order_id: string; amount: number | null; created_at: string }>(
    orders.map((o) => o.id),
    (chunk, from, to) =>
      admin
        .from("payment_events")
        .select("id, order_id, amount, created_at")
        .in("order_id", chunk)
        .eq("event_type", "REFUNDED")
        .order("id")
        .range(from, to),
  );
  const byOrder = new Map<string, { sum: number; recent: boolean }>();
  for (const e of events) {
    const agg = byOrder.get(e.order_id) ?? { sum: 0, recent: false };
    agg.sum += e.amount ?? 0;
    if (Date.parse(e.created_at) >= Date.parse(graceCutoff)) agg.recent = true;
    byOrder.set(e.order_id, agg);
  }

  for (const order of orders) {
    const agg = byOrder.get(order.id) ?? { sum: 0, recent: false };
    if (agg.recent) continue;
    if (agg.sum === order.refunded_amount) continue;

    await raiseWarning(admin, open, warningKey("REFUND_LEDGER_MISMATCH", "order", order.id), {
      payload: { order_id: order.id, check: "REFUND_LEDGER_MISMATCH", ledger_sum: agg.sum, order_refunded_amount: order.refunded_amount },
      error_message: `환불 원장 합계(${agg.sum})와 주문 누적 환불액(${order.refunded_amount})이 다릅니다. order_id=${order.id}`,
    });
  }
}

// 대사 ④ — ORDER_PAID가 처리됐는데(결제완료 주문) 이용권이 하나도 없는 주문을 찾는다. grants가
// 원래 비어 있을 수 있어(기본값 COURSE_ACCESS 1건은 항상 만들어지므로) "0건"은 항상 이상 신호다.
// PARTIALLY_REFUNDED도 대상에 포함한다(부분 환불은 수강 포기라 이용권이 회수되지만, 회수는
// revoked_at을 채울 뿐 행을 지우지 않으므로 "이용권 행 0건"은 여전히 이상 신호다 — S-4a). 기준 시각은 approved_at이 아니라 **paid_at**(결제 완료 시각)을 쓴다
// — approved_at은 결제 전 단계라 아무 관련이 없다. PAID_EVENT_GRACE_MINUTES(대사 ②가 이미 쓰는
// 10분 유예, checkPaidEventsWithUnpaidOrders 근처에 선언돼 있다)를 재사용해, 같은 배치 안에서
// 결제는 됐지만 아직 지급 핸들러가 안 돈 정상 주문을 거짓 경보로 잡지 않는다.
async function checkPaidOrdersWithoutEntitlements(open: OpenWarnings) {
  const admin = createAdminClient();

  const graceCutoff = new Date(Date.now() - PAID_EVENT_GRACE_MINUTES * 60_000).toISOString();
  const lookbackCutoff = new Date(Date.now() - PAID_EVENT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const paidOrders = await fetchAllPages<{ id: string }>((from, to) =>
    admin
      .from("orders")
      .select("id")
      .in("payment_status", ["PAID", "PARTIALLY_REFUNDED"])
      .not("paid_at", "is", null)
      .lt("paid_at", graceCutoff)
      .gte("paid_at", lookbackCutoff)
      .order("id")
      .range(from, to),
  );

  // 이용권이 하나라도 있는 주문 집합 — 주문마다 세지 않고 100개씩 묶어 한 번에 읽는다.
  const withEntitlement = new Set(
    (
      await fetchInChunks<{ id: string; order_id: string | null }>(
        paidOrders.map((o) => o.id),
        (chunk, from, to) =>
          admin.from("entitlements").select("id, order_id").in("order_id", chunk).order("id").range(from, to),
      )
    ).map((e) => e.order_id),
  );

  for (const order of paidOrders) {
    if (withEntitlement.has(order.id)) continue;

    await raiseWarning(admin, open, warningKey("PAID_ORDER_WITHOUT_ENTITLEMENTS", "order", order.id), {
      payload: { order_id: order.id, check: "PAID_ORDER_WITHOUT_ENTITLEMENTS" },
      error_message: `결제완료 주문인데 이용권이 하나도 없습니다 — ORDER_PAID 처리가 누락됐을 수 있습니다. order_id=${order.id}`,
    });
  }
}

// 대사 ④의 짝 — 직권 부여(무료, WAIVED)로 끝난 주문인데 이용권이 하나도 없는 주문. 직권 부여는 결제 원장이
// 없고 paid_at도 비어 있어 대사 ④가 못 본다. 기준 시각은 직권 부여를 남긴 주문 이벤트(ACCESS_GRANTED)의 created_at이다.
// 같은 유예(PAID_EVENT_GRACE_MINUTES)로, 같은 배치에서 부여는 됐지만 이용권 핸들러가 아직 안 돈 정상 주문을 거짓 경보로 잡지 않는다.
async function checkWaivedOrdersWithoutEntitlements(open: OpenWarnings) {
  const admin = createAdminClient();

  const graceCutoff = new Date(Date.now() - PAID_EVENT_GRACE_MINUTES * 60_000).toISOString();
  const lookbackCutoff = new Date(Date.now() - PAID_EVENT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const grantEvents = await fetchAllPages<{ id: string; order_id: string; orders: unknown }>((from, to) =>
    admin
      .from("order_events")
      .select("id, order_id, orders(payment_status)")
      .eq("event_type", "ACCESS_GRANTED")
      .lt("created_at", graceCutoff)
      .gte("created_at", lookbackCutoff)
      .order("id")
      .range(from, to),
  );
  const waivedOrderIds = [
    ...new Set(
      grantEvents
        .filter((event) => (one(event.orders) as { payment_status: string } | null)?.payment_status === "WAIVED")
        .map((event) => event.order_id),
    ),
  ];

  const withEntitlement = new Set(
    (
      await fetchInChunks<{ id: string; order_id: string | null }>(waivedOrderIds, (chunk, from, to) =>
        admin.from("entitlements").select("id, order_id").in("order_id", chunk).order("id").range(from, to),
      )
    ).map((e) => e.order_id),
  );

  for (const orderId of waivedOrderIds) {
    if (withEntitlement.has(orderId)) continue;

    await raiseWarning(admin, open, warningKey("WAIVED_ORDER_WITHOUT_ENTITLEMENTS", "order", orderId), {
      payload: { order_id: orderId, check: "WAIVED_ORDER_WITHOUT_ENTITLEMENTS" },
      error_message: `직권 부여(무료)된 주문인데 이용권이 하나도 없습니다 — ORDER_ACCESS_GRANTED 처리가 누락됐을 수 있습니다. order_id=${orderId}`,
    });
  }
}

// 대사 ⑩ — 폐강을 시작했는데 학생 처리를 방치한 개설강의.
// 폐강 시작은 결제 완료·무료(직권 부여) 수강생을 자동으로 환불·종료하지 않는다(ADR-0021) — 관리자가 학생별로 처리해야 한다. 그래서 시작만 하고
// 방치하면 학생 돈이 그대로 남는다. 폐강 시작 STALE_CANCELLING_DAYS일이 지났는데 처리 안 된 수강생(승인 대기·승인됨)이 있으면 개설강의마다
// 경고 한 건(읽기 전용 — 아무것도 자동으로 처리하지 않는다). 처리가 끝나거나 폐강이 완료되면 경고 조건이 사라진다.
const STALE_CANCELLING_DAYS = 3;

async function checkStaleCancellingOfferings(open: OpenWarnings) {
  const admin = createAdminClient();

  const cutoff = new Date(Date.now() - STALE_CANCELLING_DAYS * 86_400_000).toISOString();
  const offerings = await fetchAllPages<{ id: string; status_changed_at: string }>((from, to) =>
    admin
      .from("course_offerings")
      .select("id, status_changed_at")
      .eq("status", "CANCELLING")
      .lt("status_changed_at", cutoff)
      .order("id")
      .range(from, to),
  );
  if (offerings.length === 0) return;

  const remaining = await fetchInChunks<{ id: string; course_offering_id: string }>(
    offerings.map((o) => o.id),
    (chunk, from, to) =>
      admin
        .from("orders")
        .select("id, course_offering_id")
        .in("course_offering_id", chunk)
        .in("status", ["PENDING", "APPROVED"])
        .order("id")
        .range(from, to),
  );
  const countByOffering = new Map<string, number>();
  for (const row of remaining) countByOffering.set(row.course_offering_id, (countByOffering.get(row.course_offering_id) ?? 0) + 1);

  for (const offering of offerings) {
    const count = countByOffering.get(offering.id) ?? 0;
    if (count === 0) continue;

    const days = Math.floor((Date.now() - new Date(offering.status_changed_at).getTime()) / 86_400_000);
    await raiseWarning(admin, open, warningKey("CANCELLING_OFFERING_STALLED", "offering", offering.id), {
      payload: { offering_id: offering.id, check: "CANCELLING_OFFERING_STALLED" },
      error_message: `폐강을 시작한 지 ${days}일이 지났는데 처리 안 된 수강생이 ${count}명 있습니다(기준: ${STALE_CANCELLING_DAYS}일) — 결제하신 학생의 환불·정리가 방치됐을 수 있습니다. 개설강의 상세의 「수강생 처리」에서 처리하세요. offering_id=${offering.id}`,
    });
  }
}

// 대사 ⑪(ADR-0022) — 종강일이 지났는데 아직 종료되지 않은 개설강의. 자동 종료가 기본이라 크론이 하루 안에 종료한다 —
// 「수동 종료」 설정이 켜진 강의는 크론이 건드리지 않으므로 관리자가 직접 종료해야 하고(1일 뒤 경고), 자동 설정인데 3일이 넘게 남아 있으면
// 크론이 멈췄거나 계속 실패한다는 뜻이다(안전망 경고). 읽기 전용 — 아무것도 자동으로 종료하지 않는다(대사는 상태를 바꾸지 않는다).
const END_PENDING_MANUAL_DAYS = 1;
const END_PENDING_AUTO_DAYS = 3;

async function checkEndPendingOfferings(open: OpenWarnings) {
  const admin = createAdminClient();

  const earliest = new Date(Date.now() - END_PENDING_MANUAL_DAYS * 86_400_000).toISOString();
  const offerings = await fetchAllPages<{ id: string; ends_at: string; manual_end: boolean }>((from, to) =>
    admin
      .from("course_offerings")
      .select("id, ends_at, manual_end")
      .in("status", ["OPEN", "CLOSED"])
      .is("deleted_at", null)
      .is("ended_at", null)
      .not("ends_at", "is", null)
      .lt("ends_at", earliest)
      .order("id")
      .range(from, to),
  );

  for (const offering of offerings) {
    const graceDays = offering.manual_end ? END_PENDING_MANUAL_DAYS : END_PENDING_AUTO_DAYS;
    const days = Math.floor((Date.now() - new Date(offering.ends_at).getTime()) / 86_400_000);
    if (days < graceDays) continue;

    await raiseWarning(admin, open, warningKey("OFFERING_END_PENDING", "offering", offering.id), {
      payload: { offering_id: offering.id, check: "OFFERING_END_PENDING" },
      error_message: offering.manual_end
        ? `종강일이 ${days}일 지났는데 아직 종료되지 않았습니다(수동 종료 설정) — 개설강의 상세에서 「강의 종료」를 눌러 주세요. offering_id=${offering.id}`
        : `종강일이 ${days}일 지났는데 자동 종료되지 않았습니다(기준: ${END_PENDING_AUTO_DAYS}일) — 크론이 멈췄거나 종료가 계속 실패하고 있을 수 있습니다. 실패 기록(INTERNAL)을 확인하거나 직접 종료하세요. offering_id=${offering.id}`,
    });
  }
}

// 대사 ⑫(ADR-0023 보충 3) — 개설강의의 개강·종료 캐시(opens_at/ends_at)가 활성 회차에서 계산한 값과 다른 곳.
// 이 두 컬럼은 입력이 아니라 트리거(sync_offering_schedule_from_sessions)가 활성 회차의 첫 시작·마지막 끝(한국 시각)으로 맞춰 두는 계산 캐시다.
// 앱 경로는 직접 못 고치지만 서비스 롤이 컬럼을 직접 UPDATE하면 어긋날 수 있고(DB에서 막지 않았다 — 시험들이 시간 경과를 흉내 내려고 직접 UPDATE한다),
// 그 구멍을 여기서 감시한다. 읽기 전용 — 아무것도 고치지 않는다. 삭제·종료된 개설강의와 활성 회차가 없는 행(회차 없이 직접 만든 옛 행)은 건너뛴다.
// S-1 이전에 만든 행은 변환 때 캐시를 다시 계산하지 않았으므로 처음에는 경고가 날 수 있다(오픈 전 DB는 초기화 예정).
type DriftSession = { session_date: string; start_time: string; end_time: string; deactivated_at: string | null };

export function expectedOfferingSchedule(sessions: DriftSession[]): { opensAt: number; endsAt: number } | null {
  const active = sessions.filter((s) => !s.deactivated_at);
  if (active.length === 0) return null;
  const at = (date: string, time: string) => new Date(`${date}T${time}+09:00`).getTime();
  return {
    opensAt: Math.min(...active.map((s) => at(s.session_date, s.start_time))),
    endsAt: Math.max(...active.map((s) => at(s.session_date, s.end_time))),
  };
}

async function checkOfferingScheduleDrift(open: OpenWarnings) {
  const admin = createAdminClient();

  const offerings = await fetchAllPages<{
    id: string;
    opens_at: string;
    ends_at: string | null;
    course_sessions: DriftSession[] | null;
  }>((from, to) =>
    admin
      .from("course_offerings")
      .select("id, opens_at, ends_at, course_sessions(session_date, start_time, end_time, deactivated_at)")
      .is("deleted_at", null)
      .is("ended_at", null)
      .order("id")
      .range(from, to),
  );

  for (const offering of offerings) {
    const expected = expectedOfferingSchedule(offering.course_sessions ?? []);
    if (!expected) continue;
    const actualOpens = new Date(offering.opens_at).getTime();
    const actualEnds = offering.ends_at ? new Date(offering.ends_at).getTime() : null;
    if (actualOpens === expected.opensAt && actualEnds === expected.endsAt) continue;

    await raiseWarning(admin, open, warningKey("OFFERING_SCHEDULE_DRIFT", "offering", offering.id), {
      payload: {
        offering_id: offering.id,
        check: "OFFERING_SCHEDULE_DRIFT",
        expected_opens_at: new Date(expected.opensAt).toISOString(),
        expected_ends_at: new Date(expected.endsAt).toISOString(),
        actual_opens_at: offering.opens_at,
        actual_ends_at: offering.ends_at,
      },
      error_message: `개설강의의 개강·종료 값이 활성 회차에서 계산한 값과 다릅니다 — 컬럼을 직접 고쳤거나 트리거가 돌지 않았을 수 있습니다. 기대 개강 ${new Date(expected.opensAt).toISOString()}, 실제 ${offering.opens_at}. 회차를 추가·취소하면 다시 계산됩니다. offering_id=${offering.id}`,
    });
  }
}

// 대사 ⑤ — 전액 환불·탈퇴로 이용권이 전부 회수됐어야 하는데 아직 유효한(회수 안 된) 이용권이
// 남아 있는지 확인한다. **두 갈래 다 확인한다**(주석이 "전액 환불·탈퇴"라고 약속했는데 실제로는
// 탈퇴만 검사하던 것을 여기서 바로잡는다 — 전액 환불 갈래가 빠져 있었다). "전액 환불"은
// payment_status='REFUNDED'(전액) 또는 PARTIALLY_REFUNDED이면서 status='CANCELLED'(부분 환불로 끝난
// 주문 — 부분 환불도 수강 포기라 이용권이 회수돼야 한다, S-4a)로 판정한다.
const REVOKE_GRACE_MINUTES = 10;

async function checkRevokedUsersWithActiveEntitlements(open: OpenWarnings) {
  const admin = createAdminClient();
  const graceCutoff = new Date(Date.now() - REVOKE_GRACE_MINUTES * 60_000).toISOString();

  // 갈래 1 — 탈퇴한 사용자.
  const withdrawnUsers = await fetchAllPages<{ id: string }>((from, to) =>
    admin
      .from("users")
      .select("id")
      .not("withdrawn_at", "is", null)
      .lt("withdrawn_at", graceCutoff)
      .order("id")
      .range(from, to),
  );
  // 회수되지 않은 이용권이 있는 사용자 집합 — 사용자마다 세지 않고 100명씩 묶어 한 번에 읽는다.
  const usersWithActive = new Set(
    (
      await fetchInChunks<{ id: string; user_id: string }>(
        withdrawnUsers.map((u) => u.id),
        (chunk, from, to) =>
          admin
            .from("entitlements")
            .select("id, user_id")
            .in("user_id", chunk)
            .is("revoked_at", null)
            .order("id")
            .range(from, to),
      )
    ).map((e) => e.user_id),
  );

  for (const user of withdrawnUsers) {
    if (!usersWithActive.has(user.id)) continue;

    await raiseWarning(admin, open, warningKey("WITHDRAWN_USER_WITH_ACTIVE_ENTITLEMENTS", "user", user.id), {
      payload: { user_id: user.id, check: "WITHDRAWN_USER_WITH_ACTIVE_ENTITLEMENTS" },
      error_message: `탈퇴한 사용자인데 회수되지 않은 이용권이 있습니다 — USER_WITHDRAWN 처리가 누락됐을 수 있습니다. user_id=${user.id}`,
    });
  }

  // 갈래 2 — 끝난 주문(CANCELLED). 환불(전액·부분)뿐 아니라 환불 없이 종료(ADMIN_CLOSED)·일정 변경 제외 등
  // 취소된 지 10분이 지난 뒤 활성 이용권이 남아 있으면 경고한다.
  const cancelledOrders = await fetchAllPages<{ id: string; user_id: string }>((from, to) =>
    admin
      .from("orders")
      .select("id, user_id")
      .eq("status", "CANCELLED")
      .not("cancelled_at", "is", null)
      .lt("cancelled_at", graceCutoff)
      .order("id")
      .range(from, to),
  );
  const ordersWithActive = new Set(
    (
      await fetchInChunks<{ id: string; order_id: string | null }>(
        cancelledOrders.map((o) => o.id),
        (chunk, from, to) =>
          admin
            .from("entitlements")
            .select("id, order_id")
            .in("order_id", chunk)
            .is("revoked_at", null)
            .order("id")
            .range(from, to),
      )
    ).map((e) => e.order_id),
  );

  for (const order of cancelledOrders) {
    if (!ordersWithActive.has(order.id)) continue;

    await raiseWarning(admin, open, warningKey("CLOSED_ORDER_WITH_ACTIVE_ENTITLEMENTS", "order", order.id), {
      payload: { order_id: order.id, user_id: order.user_id, check: "CLOSED_ORDER_WITH_ACTIVE_ENTITLEMENTS" },
      error_message: `끝난 주문인데 회수되지 않은 이용권 — 회수 처리 누락 또는 늦은 부여. order_id=${order.id}`,
    });
  }

  // 갈래 3 — 종료된 강의(ended_at이 10분 전 이전). 종료 취소로 ended_at이 null이 되면 대상에서 빠진다.
  // 종료된 강의에 속한 승인(APPROVED) 주문인데 활성 이용권이 남아 있는 경우 경고한다.
  const endedOfferings = await fetchAllPages<{ id: string }>((from, to) =>
    admin
      .from("course_offerings")
      .select("id")
      .not("ended_at", "is", null)
      .lt("ended_at", graceCutoff)
      .order("id")
      .range(from, to),
  );

  if (endedOfferings.length > 0) {
    const endedOfferingOrders = await fetchInChunks<{ id: string; user_id: string }>(
      endedOfferings.map((o) => o.id),
      (chunk, from, to) =>
        admin
          .from("orders")
          .select("id, user_id")
          .in("course_offering_id", chunk)
          .eq("status", "APPROVED")
          .order("id")
          .range(from, to),
    );

    const endedOrdersWithActive = new Set(
      (
        await fetchInChunks<{ id: string; order_id: string | null }>(
          endedOfferingOrders.map((o) => o.id),
          (chunk, from, to) =>
            admin
              .from("entitlements")
              .select("id, order_id")
              .in("order_id", chunk)
              .is("revoked_at", null)
              .order("id")
              .range(from, to),
        )
      ).map((e) => e.order_id),
    );

    for (const order of endedOfferingOrders) {
      if (!endedOrdersWithActive.has(order.id)) continue;

      await raiseWarning(admin, open, warningKey("ENDED_OFFERING_WITH_ACTIVE_ENTITLEMENTS", "order", order.id), {
        payload: { order_id: order.id, user_id: order.user_id, check: "ENDED_OFFERING_WITH_ACTIVE_ENTITLEMENTS" },
        error_message: `종료된 강의인데 회수되지 않은 이용권 — 회수 처리 누락 또는 늦은 부여(order_id=${order.id})`,
      });
    }
  }
}

// 대사 ⑥ — 관리자가 승인(APPROVED)했는데 N일이 지나도록 결제가 안 된 주문. checkStalePendingOrders
// (PENDING 방치)와 짝이다 — 승인 후에도 결제 없이 방치되면 좌석이 계속 잠긴다.
const STALE_APPROVED_UNPAID_DAYS = 14;

async function checkStaleApprovedUnpaidOrders() {
  const admin = createAdminClient();

  const staleCutoff = new Date(Date.now() - STALE_APPROVED_UNPAID_DAYS * 86_400_000).toISOString();
  const { data: staleOrders } = await admin
    .from("orders")
    .select("id, approved_at")
    .eq("status", "APPROVED")
    .eq("payment_status", "UNPAID")
    .lt("approved_at", staleCutoff);

  for (const order of staleOrders ?? []) {
    const { data: existing } = await admin
      .from("dead_letters")
      .select("id")
      .eq("source", "INTEGRITY")
      .eq("resolved", false)
      .contains("payload", { order_id: order.id, check: "STALE_APPROVED_UNPAID" })
      .limit(1)
      .maybeSingle();
    if (existing) continue;

    const daysSinceApproved = Math.floor(
      (Date.now() - new Date(order.approved_at).getTime()) / 86_400_000,
    );

    await admin.from("dead_letters").insert({
      source: "INTEGRITY",
      payload: { order_id: order.id, check: "STALE_APPROVED_UNPAID" },
      error_message: `승인 후 ${daysSinceApproved}일째 미결제 상태입니다(기준: ${STALE_APPROVED_UNPAID_DAYS}일) — 좌석이 계속 잠겨 있습니다. order_id=${order.id}`,
    });
  }
}

// 대사 ⑦ — 승인 결과 미기록 탐지(로 재정의, 2026-10-02). 예전 ⑦은 원장의 PAYMENT_INITIATED가 결과 없이 남은 주문을
// 찾았는데, 창을 닫고 포기한 정상 시도까지 "웹훅 유실"로 오탐했다. 지금은 우리 서버가 PG에 승인을 요청했다는 표식
// (payment_attempts.confirm_requested_at, completeCheckout이 승인 호출 직전에 남김)이 있는데 그 뒤로 원장에 **그 시도의** 성공·실패
// 이벤트가 하나도 안 생긴 경우만 잡는다(시도 단위 판정) — 승인 응답 시간 초과·서버 중단 등으로 돈이 움직였을 수 있는 진짜 위험이다.
// 웹훅(PAYMENT_STATUS_CHANGED)이 정상 도착하면 성공 이벤트가 생겨 경고 대상이 아니다.
const UNRESOLVED_CONFIRM_MINUTES = 30; // D2 확정
const UNRESOLVED_CONFIRM_LOOKBACK_DAYS = 30;

async function checkUnresolvedConfirms(open: OpenWarnings) {
  const admin = createAdminClient();

  const cutoff = new Date(Date.now() - UNRESOLVED_CONFIRM_MINUTES * 60_000).toISOString();
  const lookbackCutoff = new Date(Date.now() - UNRESOLVED_CONFIRM_LOOKBACK_DAYS * 86_400_000).toISOString();

  const attempts = await fetchAllPages<{ id: string; order_id: string; confirm_requested_at: string }>((from, to) =>
    admin
      .from("payment_attempts")
      .select("id, order_id, confirm_requested_at")
      .not("confirm_requested_at", "is", null)
      .lt("confirm_requested_at", cutoff)
      .gte("confirm_requested_at", lookbackCutoff)
      .order("id")
      .range(from, to),
  );

  const candidateOrderIds = [...new Set(attempts.map((a) => a.order_id))];

  // 후보 주문들의 성공·실패 이벤트를 100개씩 묶어 읽고, 시도마다 "그 시도의 결과"가 있는지 본다 — 주문 단위가 아니라
  // 시도 단위(metadata.attempt_ref, lib/payment/attempt-result.ts). 예전엔 같은 주문의 다른 시도가 성공해도 해결로 봐서,
  // 승인 응답이 유실된 시도(실제로 결제됐을 수 있음)를 놓쳤다.
  const results = await fetchInChunks<{ order_id: string; event_type: string; created_at: string; metadata: unknown }>(
    candidateOrderIds,
    (chunk, from, to) =>
      admin
        .from("payment_events")
        .select("order_id, event_type, created_at, metadata")
        .in("order_id", chunk)
        .in("event_type", [...RESULT_EVENT_TYPES])
        .order("created_at", { ascending: false })
        .range(from, to),
  );
  const resultsByOrder = new Map<string, typeof results>();
  for (const r of results) {
    const list = resultsByOrder.get(r.order_id) ?? [];
    list.push(r);
    resultsByOrder.set(r.order_id, list);
  }

  for (const attempt of attempts) {
    if (resultForAttempt(attempt, resultsByOrder.get(attempt.order_id) ?? [])) continue;

    await raiseWarning(admin, open, warningKey("UNRESOLVED_CONFIRM", "order", attempt.order_id), {
      payload: { order_id: attempt.order_id, payment_attempt_id: attempt.id, check: "UNRESOLVED_CONFIRM" },
      error_message: `PG에 결제 승인을 요청했는데 ${UNRESOLVED_CONFIRM_MINUTES}분 넘게 그 시도(결제 요청 이력의 시도 ${attempt.id.slice(0, 8)})의 결과(성공·실패)가 원장에 없습니다 — 승인 응답이 유실됐거나 웹훅이 오지 않았을 수 있습니다. PG 관리화면에서 그 시도의 실제 결제 여부를 확인하세요. 결제됐는데 주문이 미결제면 주문 상세에서 수동 확정하고, 주문이 이미 다른 시도로 결제완료면 이중결제이므로 환불하세요.`,
    });
  }
}

// 대사 ⑧ — 열린 환불 요청이 60분 넘게 안 닫힘(B D15).
// 대사 ⑦과 달리 "주문 최신 이벤트"가 아니라 REFUND_REQUESTED 행 자체를 본다 —
// 그 뒤에 REFUNDED/REFUND_REQUEST_FAILED가 없으면 열린 요청이다.
const STALE_OPEN_REFUND_LOOKBACK_DAYS = 30;

async function checkStaleOpenRefundRequests(open: OpenWarnings) {
  const admin = createAdminClient();

  const cutoff = new Date(Date.now() - STALE_OPEN_REFUND_MINUTES * 60_000).toISOString();
  const lookbackCutoff = new Date(
    Date.now() - STALE_OPEN_REFUND_LOOKBACK_DAYS * 86_400_000,
  ).toISOString();

  const requested = await fetchAllPages<{ id: string; order_id: string | null; created_at: string }>((from, to) =>
    admin
      .from("payment_events")
      .select("id, order_id, created_at")
      .eq("event_type", "REFUND_REQUESTED")
      .lt("created_at", cutoff)
      .gte("created_at", lookbackCutoff)
      .order("id")
      .range(from, to),
  );

  // 후보 주문들의 요청·닫는 이벤트를 100개씩 묶어 한 번에 읽고, "닫혔나"·"더 최근 요청이 있나"는 메모리에서 판정한다
  // (예전과 같은 규칙: 그 요청보다 created_at이 엄격히 뒤인 REFUNDED/REFUND_REQUEST_FAILED가 있으면 닫힘,
  // 같은 주문에 더 최근 REFUND_REQUESTED가 있으면 그 건만 본다).
  const orderIds = [...new Set(requested.map((r) => r.order_id).filter((id): id is string => !!id))];
  const related = await fetchInChunks<{ id: string; order_id: string; event_type: string; created_at: string }>(
    orderIds,
    (chunk, from, to) =>
      admin
        .from("payment_events")
        .select("id, order_id, event_type, created_at")
        .in("order_id", chunk)
        .in("event_type", ["REFUNDED", "REFUND_REQUEST_FAILED", "REFUND_REQUESTED"])
        .order("id")
        .range(from, to),
  );
  const relatedByOrder = new Map<string, typeof related>();
  for (const e of related) {
    const list = relatedByOrder.get(e.order_id) ?? [];
    list.push(e);
    relatedByOrder.set(e.order_id, list);
  }

  for (const evt of requested) {
    if (!evt.order_id) continue;
    const others = relatedByOrder.get(evt.order_id) ?? [];

    // 이 요청이 그 주문의 "열린 환불 요청"(가장 최근 요청이고 아직 안 닫힘)일 때만 경고한다 — 관리자 화면·파사드와 같은 판정
    // (lib/payment/ledger-view.ts). 더 최근 요청이 있거나 닫혔으면 대상 아님.
    if (findOpenRefundRequest(others)?.id !== evt.id) continue;

    await raiseWarning(admin, open, warningKey("STALE_OPEN_REFUND_REQUEST", "order", evt.order_id), {
      payload: {
        order_id: evt.order_id,
        payment_event_id: evt.id,
        check: "STALE_OPEN_REFUND_REQUEST",
      },
      error_message: `환불 요청(REFUND_REQUESTED)이 ${STALE_OPEN_REFUND_MINUTES}분 넘게 열려 있습니다 — PG 콘솔에서 취소 여부를 확인하세요. 취소되지 않았으면 /admin/orders/${evt.order_id}에서 「요청 실패로 표시」, 이미 환불했으면 「PG 외 환불 반영」을 사용하세요.`,
    });
  }
}

// 명령 레일 CR-2 — 등록부(lib/commands/registry.ts)에 없는 명령 이름을 가리키는 활성 통제 스위치.
// 명령 이름이 바뀌거나 지워지면 그 이름을 가리키던 스위치는 아무것도 막지 않게 된다(조용한 무효). DB는 명령 목록을
// 모르므로(목록의 주인은 TS) 여기서 찾아 경고만 남긴다 — 스위치를 자동으로 해제하지 않는다.
async function checkUnknownSwitchTargets(open: OpenWarnings) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("rail_switches")
    .select("id, target, user_id")
    .eq("level", "COMMAND")
    .is("cleared_at", null);
  if (error) throw new Error(`통제 스위치 조회 실패: ${error.message}`);

  for (const row of data ?? []) {
    if (row.target && isCommandCode(row.target)) continue;
    await raiseWarning(admin, open, warningKey("UNKNOWN_SWITCH_TARGET", "switch", row.id), {
      payload: { switch_id: row.id, target: row.target, user_id: row.user_id, check: "UNKNOWN_SWITCH_TARGET" },
      error_message: `통제 스위치가 등록부에 없는 명령 「${row.target}」을 가리킵니다 — 아무것도 막지 않는 상태입니다. 명령 이름이 바뀌었는지 확인하고 해제 후 새 이름으로 다시 거세요.`,
    });
  }
}

// F-9: 탈퇴 회원의 미환불 주문 대사.
// 탈퇴로 취소(CANCELLED)된 주문 중 결제 잔액(final_amount - refunded_amount > 0)이 남아있고 아직 관리자 마무리(NO_REFUND_DECIDED)가 안 된 건 경고.
async function checkWithdrawnUnrefundedOrders(open: OpenWarnings) {
  const admin = createAdminClient();
  const { data: cancelledOrders, error } = await admin
    .from("orders")
    .select("id, user_id, final_amount, refunded_amount")
    .eq("status", "CANCELLED")
    .gt("final_amount", 0);
  if (error) throw new Error(`탈퇴 미환불 주문 조회 실패: ${error.message}`);

  const candidates = (cancelledOrders ?? []).filter(
    (o) => (o.final_amount ?? 0) - (o.refunded_amount ?? 0) > 0,
  );
  if (candidates.length === 0) return;

  const orderIds = candidates.map((o) => o.id);
  const events = await fetchInChunks<{ id: string; order_id: string; event_type: string; payload: unknown }>(
    orderIds,
    (chunk, from, to) =>
      admin
        .from("order_events")
        .select("id, order_id, event_type, payload")
        .in("order_id", chunk)
        .in("event_type", ["CANCELLED", "NO_REFUND_DECIDED"])
        .order("id")
        .range(from, to),
  );

  const eventsByOrder = new Map<string, typeof events>();
  for (const e of events) {
    const list = eventsByOrder.get(e.order_id) ?? [];
    list.push(e);
    eventsByOrder.set(e.order_id, list);
  }

  for (const order of candidates) {
    const evts = eventsByOrder.get(order.id) ?? [];
    const hasDecided = evts.some((e) => e.event_type === "NO_REFUND_DECIDED");
    if (hasDecided) continue;

    const cancelEvt = evts.find((e) => e.event_type === "CANCELLED");
    const isWithdrawn = (cancelEvt?.payload as { cause?: string } | null)?.cause === "WITHDRAWN";
    if (!isWithdrawn) continue;

    const remaining = (order.final_amount ?? 0) - (order.refunded_amount ?? 0);
    await raiseWarning(admin, open, warningKey("WITHDRAWN_UNREFUNDED_ORDER", "order", order.id), {
      payload: { order_id: order.id, user_id: order.user_id, remaining, check: "WITHDRAWN_UNREFUNDED_ORDER" },
      error_message: `회원 탈퇴로 취소된 주문에 미환불 잔액 ${remaining.toLocaleString()}원이 남아 있습니다. /admin/orders/${order.id}에서 환불을 진행하거나 「환불하지 않고 마무리」를 결정하세요.`,
    });
  }
}

// F-9: 감사 게이트(AUDIT) 비활성화 대사.
// system_gates.AUDIT 스위치가 닫혀 있고(status = 'CLOSED') 6시간 이상 지속된 경우 경고.
const AUDIT_GATE_MAX_CLOSED_HOURS = 6;
async function checkAuditGateClosed(open: OpenWarnings) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("system_gates")
    .select("code, status, changed_at")
    .eq("code", "AUDIT")
    .eq("status", "CLOSED")
    .maybeSingle();
  if (error) throw new Error(`감사 게이트 조회 실패: ${error.message}`);
  if (!data) return;

  const closedDurationMs = Date.now() - new Date(data.changed_at).getTime();
  if (closedDurationMs > AUDIT_GATE_MAX_CLOSED_HOURS * 3600_000) {
    const hours = Math.floor(closedDurationMs / 3600_000);
    await raiseWarning(admin, open, warningKey("AUDIT_GATE_CLOSED", "switch", "AUDIT"), {
      payload: { gate_code: "AUDIT", closed_hours: hours, check: "AUDIT_GATE_CLOSED" },
      error_message: `감사(AUDIT) 게이트가 꺼진 상태로 ${hours}시간 이상 경과했습니다. 시스템 감사 기록 누락 위험이 있으니 게이트를 다시 활성화해 주세요.`,
    });
  }
}

// F-9: 종료된 개설강의의 미처리 환불 신청 대사.
// 개설강의가 종료된 지 7일이 넘었는데 아직 처리되지 않은 수강생 환불 신청이 남아있는 경우 경고.
const ENDED_OFFERING_REFUND_STALE_DAYS = 7;
async function checkEndedOfferingOpenRefundRequests(open: OpenWarnings) {
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - ENDED_OFFERING_REFUND_STALE_DAYS * 86_400_000).toISOString();
  const { data: endedOfferings, error } = await admin
    .from("course_offerings")
    .select("id, label, ended_at")
    .not("ended_at", "is", null)
    .lt("ended_at", cutoff);
  if (error) throw new Error(`종료된 개설강의 조회 실패: ${error.message}`);
  if (!endedOfferings || endedOfferings.length === 0) return;

  const offeringIds = endedOfferings.map((o) => o.id);
  const { data: orders } = await admin
    .from("orders")
    .select("id, course_offering_id, status")
    .in("course_offering_id", offeringIds);
  if (!orders || orders.length === 0) return;

  const events = await fetchInChunks<{ id: string; order_id: string; event_type: string; created_at: string }>(
    orders.map((o) => o.id),
    (chunk, from, to) =>
      admin
        .from("order_events")
        .select("id, order_id, event_type, created_at")
        .in("order_id", chunk)
        .in("event_type", ["REFUND_REQUESTED", "REFUND_REQUEST_REJECTED", "CANCELLED", "CLOSED"])
        .order("created_at")
        .range(from, to),
  );

  const eventsByOrder = new Map<string, typeof events>();
  for (const e of events) {
    const list = eventsByOrder.get(e.order_id) ?? [];
    list.push(e);
    eventsByOrder.set(e.order_id, list);
  }

  for (const order of orders) {
    const evts = eventsByOrder.get(order.id) ?? [];
    const openReq = findOpenRefundRequest(evts);
    // 주문 레벨 환불 신청(REFUND_REQUESTED가 최신) 확인
    const latest = evts[evts.length - 1];
    if (latest && latest.event_type === "REFUND_REQUESTED") {
      await raiseWarning(admin, open, warningKey("ENDED_OFFERING_OPEN_REFUND", "order", order.id), {
        payload: { order_id: order.id, course_offering_id: order.course_offering_id, check: "ENDED_OFFERING_OPEN_REFUND" },
        error_message: `강의가 종료된 지 ${ENDED_OFFERING_REFUND_STALE_DAYS}일 이상 지났으나 주문에 미처리된 환불 신청이 남아 있습니다. /admin/orders/${order.id}에서 처리하세요.`,
      });
    }
  }
}

// A-8: 대사 ⑬ checkOfferingLedgerDrift — 원장 재생 값과 현재 행 비교
// 원장(course_offering_events)에 없는 직접 UPDATE로 값이 변조된 경우 경고를 발행한다.
// 비교 대상: label, location, price, capacity, auto_approve, manual_end, required_terms_types, notice_text, status
export async function checkOfferingLedgerDrift(open: OpenWarnings) {
  const admin = createAdminClient();

  // 1. 활성/완료 개설강의 조회 (F-2 이후 CREATED 사건이 있는 개설강의만 대상)
  const offerings = await fetchAllPages<{
    id: string;
    label: string | null;
    location: string | null;
    price: number | null;
    capacity: number | null;
    auto_approve: boolean | null;
    manual_end: boolean | null;
    required_terms_types: string[] | null;
    notice_text: string | null;
    status: string | null;
  }>((from, to) =>
    admin
      .from("course_offerings")
      .select("id, label, location, price, capacity, auto_approve, manual_end, required_terms_types, notice_text, status")
      .is("deleted_at", null)
      .order("id")
      .range(from, to),
  );

  if (offerings.length === 0) return;

  const offeringIds = offerings.map((o) => o.id);

  // 2. 해당 개설강의들의 사건 조회 (CREATED, UPDATED, STATUS_CHANGED, CANCEL_STARTED, CANCEL_COMPLETED)
  const events = await fetchInChunks<{
    id: string;
    course_offering_id: string;
    event_type: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    created_at: string;
  }>(
    offeringIds,
    (chunk, from, to) =>
      admin
        .from("course_offering_events")
        .select("id, course_offering_id, event_type, before, after, created_at")
        .in("course_offering_id", chunk)
        .in("event_type", ["CREATED", "UPDATED", "STATUS_CHANGED", "CANCEL_STARTED", "CANCEL_COMPLETED"])
        .order("created_at")
        .range(from, to),
  );

  const eventsByOffering = new Map<string, typeof events>();
  for (const ev of events) {
    const list = eventsByOffering.get(ev.course_offering_id) ?? [];
    list.push(ev);
    eventsByOffering.set(ev.course_offering_id, list);
  }

  for (const offering of offerings) {
    const evts = eventsByOffering.get(offering.id) ?? [];
    const createdEv = evts.find((e) => e.event_type === "CREATED");
    // F-2 이전에 만들어진 개설강의는 CREATED 사건이 없으므로 비교 대상에서 건너뜀
    if (!createdEv || !createdEv.after) continue;

    // 원장에서 재생한 최신 상태 계산
    const ledgerState: Record<string, unknown> = {
      label: createdEv.after.label ?? null,
      location: createdEv.after.location ?? null,
      price: createdEv.after.price ?? null,
      capacity: createdEv.after.capacity ?? null,
      auto_approve: createdEv.after.auto_approve ?? false,
      manual_end: createdEv.after.manual_end ?? false,
      required_terms_types: createdEv.after.required_terms_types ?? [],
      notice_text: createdEv.after.notice_text ?? null,
      status: "OPEN", // 기본 생성 상태
    };

    // 그 뒤 발생한 사건들의 after 패치 누적 적용
    for (const ev of evts) {
      if (ev.id === createdEv.id || !ev.after) continue;
      if (ev.event_type === "UPDATED") {
        for (const [k, v] of Object.entries(ev.after)) {
          ledgerState[k] = v;
        }
      } else if (
        ev.event_type === "STATUS_CHANGED" ||
        ev.event_type === "CANCEL_STARTED" ||
        ev.event_type === "CANCEL_COMPLETED"
      ) {
        if ("status" in ev.after && ev.after.status) {
          ledgerState.status = ev.after.status;
        }
      }
    }

    // 현재 행의 값과 원장 재생 값 비교
    const columnsToCompare: Array<keyof typeof offering> = [
      "label",
      "location",
      "price",
      "capacity",
      "auto_approve",
      "manual_end",
      "notice_text",
      "status",
    ];

    for (const col of columnsToCompare) {
      const actualVal = offering[col];
      const ledgerVal = ledgerState[col];

      const normActual = actualVal === undefined || actualVal === "" ? null : actualVal;
      const normLedger = ledgerVal === undefined || ledgerVal === "" ? null : ledgerVal;

      if (normActual !== normLedger) {
        await raiseWarning(
          admin,
          open,
          warningKey("OFFERING_LEDGER_DRIFT", "offering", `${offering.id}:${col}`),
          {
            payload: {
              offering_id: offering.id,
              column: col,
              actual_value: normActual,
              ledger_value: normLedger,
              check: "OFFERING_LEDGER_DRIFT",
            },
            error_message: `개설강의의 ${col} 값이 원장(course_offering_events)과 일치하지 않습니다 — 원장 없이 직접 수정되었을 수 있습니다. 실제값=${normActual}, 원장값=${normLedger}. offering_id=${offering.id}`,
          },
        );
      }
    }

    // required_terms_types 배열 비교
    const actualTerms = (offering.required_terms_types ?? []).slice().sort().join(",");
    const ledgerTerms = Array.isArray(ledgerState.required_terms_types)
      ? (ledgerState.required_terms_types as string[]).slice().sort().join(",")
      : "";

    if (actualTerms !== ledgerTerms) {
      await raiseWarning(
        admin,
        open,
        warningKey("OFFERING_LEDGER_DRIFT", "offering", `${offering.id}:required_terms_types`),
        {
          payload: {
            offering_id: offering.id,
            column: "required_terms_types",
            actual_value: actualTerms,
            ledger_value: ledgerTerms,
            check: "OFFERING_LEDGER_DRIFT",
          },
          error_message: `개설강의의 required_terms_types 목록이 원장과 일치하지 않습니다. 실제값=[${actualTerms}], 원장값=[${ledgerTerms}]. offering_id=${offering.id}`,
        },
      );
    }
  }
}
