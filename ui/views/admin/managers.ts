import { createClient } from "@/lib/supabase/server";
import { runQuery } from "@/lib/commands/run-command";
import { one } from "@/lib/supabase/relations";
import { formatPermissions } from "@/lib/auth/permissions";

export type AdminManagersView = {
  activeCount: number;
  rows: {
    userId: string;
    email: string;
    discordId: string;
    name: string;
    canViewStudents: boolean;
    canApproveOrders: boolean;
    canApprovePayments: boolean;
    /** "(V--)" 형식(괄호 포함 — e2e가 이 문자열을 읽는다). */
    permissionsText: string;
    grantedBy: string;
    grantedText: string;
  }[];
};

// ADMIN 전용(등록부 who: ADMIN — 명령 레일 runQuery가 판정한다, lib/commands/registry.ts).
export async function loadAdminManagers(): Promise<AdminManagersView> {
  return runQuery({ command: "ADMIN_MANAGERS_VIEW" }, async () => {
    const supabase = await createClient();
    // discord_id는 2026-09-27부터 users가 아니라 discord_accounts(이용권 모듈)에서 온다. granted_by_user 쪽은 화면에서 이메일만 쓰므로 discord_id를 아예 안 가져온다.
    const { data: managers } = await supabase
      .from("manager_permissions")
      .select(
        "user_id, can_view_students, can_approve_orders, can_approve_payments, created_at, updated_at, revoked_at, users!manager_permissions_user_id_fkey(email, name, discord_accounts(discord_id)), granted_by_user:users!manager_permissions_granted_by_fkey(email)",
      )
      .order("created_at", { ascending: false });

    const active = managers?.filter((m) => !m.revoked_at) ?? [];

    return {
      activeCount: active.length,
      rows: active.map((m) => {
        const user = one(m.users);
        const grantedBy = one(m.granted_by_user);
        return {
          userId: m.user_id,
          email: user?.email ?? "",
          discordId: one(user?.discord_accounts)?.discord_id ?? "-",
          name: user?.name ?? "-",
          canViewStudents: m.can_view_students,
          canApproveOrders: m.can_approve_orders,
          canApprovePayments: m.can_approve_payments,
          permissionsText: `(${formatPermissions({
          viewStudents: m.can_view_students,
          approveOrders: m.can_approve_orders,
          approvePayments: m.can_approve_payments,
        })})`,
          grantedBy: grantedBy?.email ?? "-",
          grantedText: new Date(m.created_at).toLocaleDateString("ko-KR"),
        };
      }),
    };
  });
}
