import { EntitlementsScreen } from "@/ui/screens/student/EntitlementsScreen";
import { loadEntitlements } from "@/ui/views/student/entitlements";

export default async function EntitlementsPage() {
  const view = await loadEntitlements();
  return <EntitlementsScreen view={view} />;
}
