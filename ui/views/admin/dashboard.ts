import { runQuery } from "@/lib/commands/run-command";
import { hasPermission } from "@/lib/auth/permissions";
import { loadAdminCounts } from "./shell";

export type AdminDashboardView = {
  isAdmin: boolean;
  /** 미처리 DLQ 건수. ADMIN이 아니면 0(조회하지 않는다). 건수 조회가 통제 스위치로 막혔으면 null. */
  dlqCount: number | null;
  /** 승인 대기 신청 건수. 이 건수를 볼 권한(ADMIN 또는 수강생 조회·승인 권한)이 없거나 건수 조회가 막혔으면 null. */
  pendingCount: number | null;
};

// 렌더는 읽기만 한다. 후속 작업 실행은 결제 웹훅 응답 직전·크론(/api/cron/outbox)·수동 버튼(manualDrainOutbox)에서만 한다.
export async function loadAdminDashboard(): Promise<AdminDashboardView> {
  return runQuery({ command: "ADMIN_DASHBOARD_VIEW" }, async (profile) => {
    const isAdmin = profile.role === "ADMIN";
    const counts = await loadAdminCounts();
    const canSeePending =
      isAdmin || hasPermission(profile.permissions, "VIEW_STUDENTS") || hasPermission(profile.permissions, "APPROVE_ORDERS");
    return { isAdmin, dlqCount: counts?.dlqCount ?? null, pendingCount: canSeePending && counts ? counts.pendingCount : null };
  });
}
