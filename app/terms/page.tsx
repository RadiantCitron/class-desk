import { TermsScreen } from "@/ui/screens/auth/TermsScreen";
import { loadTerms } from "@/ui/views/auth/terms";
import { agreeToTerms } from "./actions";

export default async function TermsPage() {
  const view = await loadTerms();
  return <TermsScreen view={view} agreeAction={agreeToTerms} />;
}
