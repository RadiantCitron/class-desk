import { DashboardScreen } from "@/ui/screens/admin/dashboard/DashboardScreen";
import { loadAdminDashboard } from "@/ui/views/admin/dashboard";
import { manualDrainOutbox } from "./system/actions";

export default async function AdminPage() {
  const view = await loadAdminDashboard();
  return <DashboardScreen view={view} drainAction={manualDrainOutbox} />;
}
