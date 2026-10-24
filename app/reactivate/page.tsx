import { signOut } from "@/app/actions/auth";
import { ReactivateScreen } from "@/ui/screens/auth/ReactivateScreen";
import { loadReactivate } from "@/ui/views/auth/reactivate";
import { reactivate } from "./actions";

export default async function ReactivatePage() {
  const view = await loadReactivate();
  return <ReactivateScreen view={view} reactivateAction={reactivate} signOutAction={signOut} />;
}
