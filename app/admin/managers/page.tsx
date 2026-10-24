import { ManagersScreen } from "@/ui/screens/admin/managers/ManagersScreen";
import { loadAdminManagers } from "@/ui/views/admin/managers";
import { grantManager, revokeManager, updateManagerPermissions } from "./actions";

export default async function AdminManagersPage() {
  const view = await loadAdminManagers();
  return (
    <ManagersScreen view={view} grantAction={grantManager} updateAction={updateManagerPermissions} revokeAction={revokeManager} />
  );
}
