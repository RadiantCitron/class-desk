import Link from "next/link";
import type { LoginView } from "@/ui/views/auth/login";
import { ActionForm, ActionFormError, ActionFormSubmitButton, type FormAction } from "@/ui/forms/ActionForm";
import { AuthShell } from "@/ui/shell/AuthShell";
import { Alert, AlertDescription } from "@/ui/shadcn/alert";
import { Input } from "@/ui/shadcn/input";

export function LoginScreen({
  view,
  requestLoginLinkAction,
}: {
  view: LoginView;
  requestLoginLinkAction: FormAction;
}) {
  return (
    <AuthShell width="md">
      <h1 className="text-2xl font-bold">class-desk 로그인</h1>
      {view.errorMessage && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{view.errorMessage}</p>
          </AlertDescription>
        </Alert>
      )}
      {view.sentEmail ? (
        <Alert>
          <AlertDescription>
            <p>
              <span className="font-mono">{view.sentEmail}</span>(으)로 로그인 링크를 보냈습니다. 메일함(스팸함 포함)을 확인해 링크를 눌러 주세요.
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <ActionForm action={requestLoginLinkAction} className="flex flex-col gap-2">
          <Input name="email" type="email" required placeholder="이메일" />
          <ActionFormError />
          <ActionFormSubmitButton variant="default">로그인 링크 받기</ActionFormSubmitButton>
        </ActionForm>
      )}
      <Link href="/signup" className="text-sm underline">
        회원가입
      </Link>
    </AuthShell>
  );
}
