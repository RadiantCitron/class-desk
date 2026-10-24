import { TermsAdminScreen } from "@/ui/screens/admin/terms/TermsAdminScreen";
import { loadAdminTerms } from "@/ui/views/admin/terms";
import { createTermsVersion } from "./actions";

export default async function AdminTermsPage() {
  const view = await loadAdminTerms();
  return <TermsAdminScreen view={view} createAction={createTermsVersion} />;
}
