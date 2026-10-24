import type { ApplyView } from "@/ui/views/student/apply";
import type { ActionResult } from "@/lib/errors";
import { FlowHeader } from "@/ui/shell/FlowHeader";
import { TermsBlock } from "@/ui/screens/auth/TermsBlock";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";

export function ApplyScreen({
  view,
  applyAction,
}: {
  view: ApplyView;
  applyAction: (offeringId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
}) {
  return (
    <main className="mx-auto w-full max-w-xl p-8">
      <FlowHeader backHref="/student" backLabel="← 대시보드로" />
      <h1 className="mt-2 text-xl font-bold">{view.title}</h1>
      <p className="mt-2 text-sm text-gray-500">{view.meta}</p>
      {view.notice && (
        <div className="mt-3 whitespace-pre-wrap rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="offering-notice">
          {view.notice}
        </div>
      )}
      {view.location && <p className="mt-1 text-sm text-gray-500">장소: {view.location}</p>}
      {view.scheduleText && <p className="mt-1 text-sm text-gray-500">일정: {view.scheduleText}</p>}
      {view.discordNotice && (
        <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          {view.discordNotice}
        </div>
      )}
      {view.description && (
        <p className="mt-3 whitespace-pre-wrap rounded border p-3 text-sm text-gray-600">
          {view.description}
        </p>
      )}

      <ActionForm action={applyAction.bind(null, view.offeringId)} className="mt-6 flex flex-col gap-4">
        {view.terms.map((t) => (
          <TermsBlock 
            key={t.type} 
            title={t.title} 
            content={t.content} 
            checkboxLabel="위 약관에 동의합니다." 
            name={`terms_${t.type}`}
            required={true}
          />
        ))}
        <ActionFormError />
        <ActionFormSubmitButton variant="default" disabled={!view.canSubmit} className="w-fit">
          신청하기
        </ActionFormSubmitButton>
      </ActionForm>

      {view.missingTermsText && (
        <p className="mt-2 text-sm text-red-600">
          다음 약관이 아직 등록되지 않았습니다: {view.missingTermsText}. 관리자에게 문의해 주세요.
        </p>
      )}
    </main>
  );
}
