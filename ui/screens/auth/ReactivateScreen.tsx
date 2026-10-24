import type { ActionResult } from "@/lib/errors";
import type { ReactivateView } from "@/ui/views/auth/reactivate";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { checkboxClass } from "@/ui/forms/controls";
import { AuthShell } from "@/ui/shell/AuthShell";
import { Button } from "@/ui/shadcn/button";

type ReactivateParams = { serviceTermsId: string; privacyTermsId: string };

export function ReactivateScreen({
  view,
  reactivateAction,
  signOutAction,
}: {
  view: ReactivateView;
  /** app/reactivate/actions.ts의 reactivate — 앞 인자(약관 id)를 이 Screen이 bind한다. */
  reactivateAction: (params: ReactivateParams, prevState: ActionResult | null, formData: FormData) => Promise<ActionResult>;
  /** app/actions/auth.ts의 signOut(redirect만 하는 액션). */
  signOutAction: () => Promise<void>;
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
      <h1 className="text-xl font-bold">탈퇴한 계정입니다</h1>
      <p className="text-sm text-muted-foreground">
        계정을 복구하면 예전 신청·결제 이력을 다시 볼 수 있습니다. 탈퇴 때 회수된 이용권과 디스코드 역할은 돌아오지 않습니다. 복구하려면 약관에 다시 동의해
        주세요.
      </p>
      <ActionForm action={reactivateAction.bind(null, view.termIds)} className="mt-2 flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" required className={checkboxClass} /> 서비스 이용약관({view.serviceVersion})에 동의합니다.
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" required className={checkboxClass} /> 개인정보 수집·이용({view.privacyVersion})에 동의합니다.
        </label>
        <ActionFormError />
        <ActionFormSubmitButton variant="default" className="self-start">
          계정 복구
        </ActionFormSubmitButton>
      </ActionForm>
      <form action={signOutAction} className="mt-2">
        <Button type="submit" variant="link" className="px-0 text-muted-foreground">
          복구하지 않고 로그아웃
        </Button>
      </form>
    </AuthShell>
  );
}
