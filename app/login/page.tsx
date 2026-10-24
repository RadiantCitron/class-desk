import { LoginScreen } from "@/ui/screens/auth/LoginScreen";
import { loadLogin } from "@/ui/views/auth/login";
import { requestLoginLink } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const view = await loadLogin(await searchParams);
  return <LoginScreen view={view} requestLoginLinkAction={requestLoginLink} />;
}
