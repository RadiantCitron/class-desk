import Link from "next/link";
import type { SignupView } from "@/ui/views/auth/signup";
import { ActionForm, ActionFormError, ActionFormSubmitButton, type FormAction } from "@/ui/forms/ActionForm";
import { AuthShell } from "@/ui/shell/AuthShell";
import { Alert, AlertDescription } from "@/ui/shadcn/alert";
import { Input } from "@/ui/shadcn/input";
import { TermsBlock } from "@/ui/screens/auth/TermsBlock";

export function SignupScreen({ view, sendSignupLinkAction }: { view: SignupView; sendSignupLinkAction: FormAction }) {
  if (view.kind === "no-terms") {
    return (
      <AuthShell width="md">
        <h1 className="text-2xl font-bold">회원가입</h1>
        <Alert variant="destructive">
          <AlertDescription>
            필수 약관이 설정되지 않았습니다. 관리자에게 문의해 주세요.
          </AlertDescription>
        </Alert>
      </AuthShell>
    );
  }

  return (
    <AuthShell width="md">
      <h1 className="text-2xl font-bold">회원가입</h1>
      {view.sentEmail ? (
        <Alert>
          <AlertDescription>
            <p>
              <span className="font-mono">{view.sentEmail}</span>(으)로 가입 링크를 보냈습니다. 메일함(스팸함 포함)을 확인해 링크를 눌러 주세요.
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            이메일로 가입 링크를 보내 드립니다. 링크를 누르면 바로 가입이 이어집니다(비밀번호 없음).
          </p>
          <ActionForm action={sendSignupLinkAction} className="mt-4 flex flex-col gap-4">
            <Input name="email" type="email" required placeholder="이메일" />
            
            <div className="flex flex-col gap-4">
              <TermsBlock
                title="서비스 이용약관 (필수)"
                content={view.service.content}
                checkboxLabel="이용약관에 동의합니다."
                name="service_agreed"
                required={true}
              />
              <TermsBlock
                title="개인정보 수집·이용 동의 (필수)"
                content={view.privacy.content}
                checkboxLabel="개인정보 수집 및 이용에 동의합니다."
                name="privacy_agreed"
                required={true}
              />
              {view.marketing && (
                <TermsBlock
                  title="마케팅 정보 수신 동의 (선택)"
                  content={view.marketing.content}
                  checkboxLabel="할인 등 안내 메일을 받겠습니다."
                  name="marketing_opt_in"
                  required={false}
                />
              )}
            </div>

            <ActionFormError />
            <ActionFormSubmitButton variant="default">가입 링크 받기</ActionFormSubmitButton>
          </ActionForm>
        </>
      )}
      <p className="mt-4 text-sm text-center">
        이미 가입했나요?{" "}
        <Link href="/login" className="underline">
          로그인
        </Link>
      </p>
    </AuthShell>
  );
}
