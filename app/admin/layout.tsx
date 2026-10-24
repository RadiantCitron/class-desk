import { signOut } from "@/app/actions/auth";
import { AdminShell } from "@/ui/shell/AdminShell";
import { loadAdminShell } from "@/ui/views/admin/shell";
import { loadGateBanner } from "@/ui/views/shared/gate-banner";

// 이 레이아웃 하위 전부를 동적 렌더링으로 고정한다(student 레이아웃과 같은 사유).
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const [gate, { nav }] = await Promise.all([loadGateBanner(), loadAdminShell()]);
  return (
    <AdminShell nav={nav} gate={gate} signOutAction={signOut}>
      {children}
    </AdminShell>
  );
}
