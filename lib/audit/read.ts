import type { createClient } from "@/lib/supabase/server";

// audit_logs 읽기(2026-10-03). 쓰기는 sinks/postgres.ts 한 곳, 읽기는 이 파일 한 곳이다.
// 관리자 화면 3곳(감사 로그·수강생 상세·주문 상세 page)에 있던 조회를 쿼리 한 글자도 바꾸지 않고 옮겼다 —
// 백엔드 가드(audit.guard)가 화면 파일 이름을 몰라도 되게 하려는 것이다(UI는 교체 가능한 껍데기).
// ADMIN만 조회하는 분기는 부르는 쪽이 한다. 세션 클라이언트를 인자로 받으므로 RLS(is_admin)가 그대로 적용된다.
type ServerClient = Awaited<ReturnType<typeof createClient>>;

// 끊긴 시도(결과 행 없는 ATTEMPTED) 개수 — 실행 도중 프로세스가 죽었다는 신호(2026-09-20
// 감사 모듈 재설계, 2단계 기록의 핵심 이득). 최근 500건 범위로만 본다 — 배지 하나 때문에
// 테이블 전체를 스캔하지 않는다.
export async function countUnresolvedAttempts(supabase: ServerClient) {
  const { data: attempted } = await supabase
    .from("audit_logs")
    .select("correlation_id")
    .eq("phase", "ATTEMPTED")
    .order("created_at", { ascending: false })
    .limit(500);

  const attemptedIds = Array.from(new Set((attempted ?? []).map((r) => r.correlation_id)));
  if (attemptedIds.length === 0) return 0;

  const { data: resolved } = await supabase
    .from("audit_logs")
    .select("correlation_id")
    .in("correlation_id", attemptedIds)
    .in("phase", ["SUCCEEDED", "FAILED"]);

  const resolvedIds = new Set((resolved ?? []).map((r) => r.correlation_id));
  return attemptedIds.filter((id) => !resolvedIds.has(id)).length;
}

export type AuditLogFilters = { action?: string; actor?: string; from?: string; to?: string };

export async function listAuditLogs(supabase: ServerClient, { action, actor, from, to }: AuditLogFilters) {
  // actor(이메일)로 거르려면 조인 테이블에 PostgREST 필터를 걸어야 하고, 그러려면
  // !inner가 필요하다. actor_user_id가 NOT NULL이라 !inner로 바꿔도 행이 줄지 않는다.
  let query = supabase
    .from("audit_logs")
    .select(
      "id, action, target_table, target_id, target_ref, phase, detail, created_at, users!inner(email)",
    )
    .neq("phase", "ATTEMPTED")
    .order("created_at", { ascending: false })
    .limit(200);

  if (action) query = query.ilike("action", `%${action}%`);
  if (actor) query = query.ilike("users.email", `%${actor}%`);
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", `${to}T23:59:59`);

  return await query;
}

export async function listStudentAuditLogs(supabase: ServerClient, studentId: string, orderIds: string[]) {
  return await supabase
    .from("audit_logs")
    .select("id, action, target_table, target_id, target_ref, phase, detail, created_at")
    .neq("phase", "ATTEMPTED")
    .or(
      [
        `actor_user_id.eq.${studentId}`,
        `and(target_table.eq.users,target_id.eq.${studentId})`,
        // 감사 기록은 append-only라 이름을 바꾸기 전(enrollments)/후(orders) 기록이
        // 함께 남아 있다 — 둘 다 조회해야 옛 기록도 타임라인에 보인다.
        ...(orderIds.length > 0
          ? [
              `and(target_table.eq.enrollments,target_id.in.(${orderIds.join(",")}))`,
              `and(target_table.eq.orders,target_id.in.(${orderIds.join(",")}))`,
            ]
          : []),
      ].join(","),
    )
    .order("created_at", { ascending: false });
}

export async function listOrderAuditLogs(supabase: ServerClient, orderId: string) {
  return await supabase
    .from("audit_logs")
    .select("id, action, target_table, phase, detail, created_at")
    .neq("phase", "ATTEMPTED")
    // 결제 시작(PAYMENT_START)은 2026-10-02부터 payment_attempts, 그 전 기록과 승인(PAYMENT_CONFIRM)은 payment_events.
    .or(
      `and(target_table.eq.orders,target_id.eq.${orderId}),and(target_table.eq.payment_events,target_id.eq.${orderId}),and(target_table.eq.payment_attempts,target_id.eq.${orderId})`,
    )
    .order("created_at", { ascending: false });
}
