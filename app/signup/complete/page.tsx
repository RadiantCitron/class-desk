import { SignupCompleteScreen } from "@/ui/screens/auth/SignupCompleteScreen";
import { loadSignupComplete } from "@/ui/views/auth/signup-complete";
import { completeSignup } from "../actions";

export default async function SignupCompletePage() {
  const view = await loadSignupComplete();
  return <SignupCompleteScreen view={view} completeAction={completeSignup} />;
}
