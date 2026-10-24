import { SignupScreen } from "@/ui/screens/auth/SignupScreen";
import { loadSignup } from "@/ui/views/auth/signup";
import { sendSignupLink } from "./actions";

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const view = await loadSignup(await searchParams);
  return <SignupScreen view={view} sendSignupLinkAction={sendSignupLink} />;
}
