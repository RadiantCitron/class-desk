import { AuditLogsScreen } from "@/ui/screens/admin/audit-logs/AuditLogsScreen";
import { loadAdminAuditLogs } from "@/ui/views/admin/audit-logs";

// 캐시된 페이지가 필터를 안 반영하면 안 되므로 매번 새로 읽는다(system/page.tsx와 같은 원칙).
export const dynamic = "force-dynamic";

export default async function AdminAuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; actor?: string; from?: string; to?: string }>;
}) {
  const view = await loadAdminAuditLogs(await searchParams);
  return <AuditLogsScreen view={view} />;
}
