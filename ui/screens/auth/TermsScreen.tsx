import type { ActionResult } from "@/lib/errors";
import type { TermsView } from "@/ui/views/auth/terms";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { AuthShell } from "@/ui/shell/AuthShell";
import { Alert, AlertDescription } from "@/ui/shadcn/alert";
import { TermsBlock } from "./TermsBlock";

type AgreeParams = { serviceTermsId: string; privacyTermsId: string };

export function TermsScreen({
  view,
  agreeAction,
}: {
  view: TermsView;
  /** app/terms/actions.ts의 agreeToTerms — 앞 인자(약관 id)를 이 Screen이 bind한다. */
  agreeAction: (params: AgreeParams, prevState: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}) {
  return (
    <AuthShell width="lg">
      <h1 className="text-xl font-bold">가입 동의</h1>
      <p className="text-sm text-muted-foreground">서비스 이용을 위해 아래 두 가지에 각각 동의해야 합니다.</p>
      <Alert className="border-amber-200 bg-amber-50 text-amber-900">
        <AlertDescription className="text-amber-900">
          <p>
            폐강·환불 등 중요 안내는 가입 시 등록한 이메일로 보내 드립니다. 수신·스팸함 확인 책임은 회원에게 있습니다.
          </p>
        </AlertDescription>
      </Alert>

      {view.kind === "no-terms" ? (
        <p className="text-sm text-red-600">등록된 약관을 찾을 수 없습니다. 관리자에게 문의해 주세요.</p>
      ) : (
        <ActionForm action={agreeAction.bind(null, view.termIds)} className="mt-2 flex flex-col gap-4">
          <TermsBlock
            title={`서비스 이용약관 (${view.service.version})`}
            content={view.service.content}
            checkboxLabel="위 내용에 동의합니다."
          />
          <TermsBlock
            title={`개인정보 수집·이용 동의 (${view.privacy.version})`}
            content={view.privacy.content}
            checkboxLabel="위 내용에 동의합니다."
          />
          <ActionFormError />
          <ActionFormSubmitButton variant="default">동의하고 계속하기</ActionFormSubmitButton>
        </ActionForm>
      )}
    </AuthShell>
  );
}
