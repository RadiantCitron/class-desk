import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { runQuery } from "@/lib/commands/run-command";
import { ADMIN_ROUTES, canAccessAdminRoute, hasPermission } from "@/lib/auth/permissions";
import type { NavItemView } from "@/ui/views/shared/nav";

export type AdminCounts = { dlqCount: number; pendingCount: number };

// 관리자 Shell(사이드바)과 대시보드가 같이 쓰는 건수. React cache()라 한 요청 안에서 한 번만 센다.
// 읽기만 한다. 갱신 시점: 새로고침·서버 액션의 revalidatePath가 layout을 무효화할 때(클라이언트 내비게이션만으로는 갱신 안 됨 — App Router layout 특성).
// 건수 조회는 통제실 통로(ADMIN_SHELL_VIEW)가 아니라 별도 조회(ADMIN_COUNTS_VIEW)라서 스위치로 막힐 수 있다 — 막히면 null이고, 관리자 틀은
// 배지만 빠진 채 그대로 열린다(관리자 틀이 건수 조회 거부를 견딘다).
export const loadAdminCounts = cache(async (): Promise<AdminCounts | null> =>
  runQuery({ command: "ADMIN_COUNTS_VIEW", onDenied: () => null }, async (profile) => {
    const isAdmin = profile.role === "ADMIN";

    let dlqCount = 0;
    if (isAdmin) {
      const supabase = await createClient();
      const { count } = await supabase
        .from("dead_letters")
        .select("id", { count: "exact", head: true })
        .eq("resolved", false);
      dlqCount = count ?? 0;
    }

    let pendingCount = 0;
    if (isAdmin || hasPermission(profile.permissions, "VIEW_STUDENTS") || hasPermission(profile.permissions, "APPROVE_ORDERS")) {
      const supabase = await createClient();
      const { count } = await supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("status", "PENDING");
      pendingCount = count ?? 0;
    }

    return { dlqCount, pendingCount };
  }));

// 메뉴는 ADMIN_ROUTES 표 하나로 결정된다(lib/auth/permissions.ts) — proxy.ts의 라우팅 차단과 같은 기준(canAccessAdminRoute)을 쓰므로
// "메뉴엔 보이는데 들어가면 막힌다"가 생기지 않는다. 옛 대시보드의 인라인 필터와 결과가 같다(ADMIN은 전부, MANAGER는 권한이 맞는 항목,
// ADMIN 전용은 숨김). 대시보드 자신("/admin")은 이제 Sidebar에 "대시보드"로 포함한다.
// 스위치 화면을 감싸는 틀이라 통제실 통로(ADMIN_SHELL_VIEW)다 — 스위치로 막히지 않는다. 직원이 아니면 메뉴가 빈다(예전과 같다).
export async function loadAdminShell(): Promise<{ nav: NavItemView[] }> {
  return runQuery({ command: "ADMIN_SHELL_VIEW", onDenied: () => ({ nav: [] }) }, async (profile) => {
    const counts = await loadAdminCounts();
    const isAdmin = profile.role === "ADMIN";

    const nav = ADMIN_ROUTES.filter((route) => canAccessAdminRoute(profile.role, profile.permissions, route.path)).map((route) => {
      let badge: number | undefined;
      if (route.path === "/admin/orders" && counts && counts.pendingCount > 0) badge = counts.pendingCount;
      if (route.path === "/admin/dlq" && isAdmin && counts && counts.dlqCount > 0) badge = counts.dlqCount;
      return { href: route.path, label: route.label, ...(badge ? { badge } : {}) };
    });
    return { nav };
  });
}
