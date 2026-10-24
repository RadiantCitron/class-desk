import type { ActionResult } from "@/lib/errors";
import type { SignupCompleteView } from "@/ui/views/auth/signup-complete";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { AuthShell } from "@/ui/shell/AuthShell";
import { TermsBlock } from "./TermsBlock";

type CompleteSignupParams = { serviceTermsId: string; privacyTermsId: string; marketingTermsId: string | null };

export function SignupCompleteScreen({
  view,
  completeAction,
}: {
  view: SignupCompleteView;
  /** app/signup/actions.ts의 completeSignup — 앞 인자(약관 id)를 이 Screen이 bind한다. */
  completeAction: (params: CompleteSignupParams, prevState: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}) {
  if (view.kind === "no-terms") {
    return (
      <AuthShell width="lg">
        <p className="text-sm text-red-600">등록된 약관을 찾을 수 없습니다. 관리자에게 문의해 주세요.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell width="lg">
      <h1 className="text-xl font-bold">약관 동의</h1>
      <p className="text-sm text-muted-foreground">인증되었습니다. 마지막으로 약관에 동의하면 가입이 끝납니다.</p>
      <ActionForm action={completeAction.bind(null, view.termIds)} className="mt-2 flex flex-col gap-4">
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
        {view.marketing && (
          <TermsBlock
            title={`광고성 정보(이메일) 수신 동의 (${view.marketing.version}) — 선택`}
            content={view.marketing.content}
            checkboxLabel="위 내용에 동의합니다(선택 — 동의하지 않아도 가입에는 영향이 없습니다)."
            name="marketing_opt_in"
            required={false}
          />
        )}
        <ActionFormError />
        <ActionFormSubmitButton variant="default">가입 완료</ActionFormSubmitButton>
      </ActionForm>
    </AuthShell>
  );
}
