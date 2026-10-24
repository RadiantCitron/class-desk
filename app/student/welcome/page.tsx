import { loadWelcomeView } from "@/ui/views/student/welcome";
import { WelcomeScreen } from "@/ui/screens/student/WelcomeScreen";
import { agreeToTermsAction } from "./actions";

export default async function WelcomePage() {
  const view = await loadWelcomeView();
  return <WelcomeScreen view={view} agreeAction={agreeToTermsAction} />;
}
