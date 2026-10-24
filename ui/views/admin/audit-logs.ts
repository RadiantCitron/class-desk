import { createClient } from "@/lib/supabase/server";
import { runQuery } from "@/lib/commands/run-command";
import { one } from "@/lib/supabase/relations";
import { countUnresolvedAttempts, listAuditLogs } from "@/lib/audit/read";

export type AuditLogsInput = { action?: string; actor?: string; from?: string; to?: string };

export type AdminAuditLogsView = {
  unresolvedCount: number;
  filters: { action: string; actor: string; from: string; to: string };
  hasFilter: boolean;
  rows: {
    id: string;
    timeText: string;
    email: string;
    action: string;
    failed: boolean;
    targetText: string;
    detailJson: string;
  }[];
};

// ADMIN 전용(2026-09-18). 매니저 본인의 조작도 감사로그에 남지만, 로그 조회 자체는 ADMIN만.
export async function loadAdminAuditLogs(input: AuditLogsInput): Promise<AdminAuditLogsView> {
  return runQuery({ command: "ADMIN_AUDIT_LOGS_VIEW" }, async () => {
    const { action, actor, from, to } = input;
    const supabase = await createClient();

    const [{ data: logs }, unresolvedCount] = await Promise.all([
      listAuditLogs(supabase, { action, actor, from, to }),
      countUnresolvedAttempts(supabase),
    ]);

    return {
      unresolvedCount,
      filters: { action: action ?? "", actor: actor ?? "", from: from ?? "", to: to ?? "" },
      hasFilter: !!(action || actor || from || to),
      rows: (logs ?? []).map((log) => ({
        id: log.id,
        timeText: new Date(log.created_at).toLocaleString("ko-KR"),
        email: one(log.users)?.email ?? "",
        action: log.action,
        failed: log.phase === "FAILED",
        targetText: `${log.target_table}${log.target_id ? ` / ${log.target_id.slice(0, 8)}…` : ""}${
        log.target_ref ? ` / ${log.target_ref}` : ""
      }`,
        detailJson: JSON.stringify(log.detail, null, 2),
      })),
    };
  });
}
