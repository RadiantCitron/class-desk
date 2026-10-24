import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// 서버/DB 가동 여부와 필수 테이블 조회 가능 여부를 확인하는 헬스체크.
//
// 2026-09-26: 로그인 없이 누구나 service_role로 15개 테이블 존재 여부와
// DB 에러 원문을 볼 수 있었다 — 내부 구조 노출 + 부하 유발 가능. `/api/cron/outbox`와 같은
// CRON_SECRET 베어러 인증으로 막는다(새 시크릿을 안 만든다 — "기계만 호출하는 내부 경로"라는
// 같은 성격이라 시크릿을 나누는 게 오히려 관리 부담만 늘린다). CRON_SECRET이 설정 안 돼
// 있으면(로컬 기본 상태) 기본값을 닫힌 쪽으로 둔다.
const REQUIRED_TABLES = [
  "users",
  "terms",
  "terms_agreements",
  "courses",
  "course_offerings",
  "course_sessions",
  "discount_rules",
  "order_events",
  "orders",
  "payment_events",
  "entitlements",
  "entitlement_uses",
  "outbox_messages",
  "dead_letters",
  "audit_logs",
] as const;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");

  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const results = await Promise.all(
    REQUIRED_TABLES.map(async (table) => {
      const { error } = await admin.from(table).select("*", { count: "exact", head: true });
      return { table, ok: !error, error: error?.message };
    }),
  );

  const allOk = results.every((r) => r.ok);

  return NextResponse.json(
    { status: allOk ? "ok" : "degraded", tables: results },
    { status: allOk ? 200 : 500 },
  );
}
