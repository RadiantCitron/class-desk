import type { ActionResult } from "@/lib/errors";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { Input } from "@/ui/shadcn/input";
import type { AdminDlqView } from "@/ui/views/admin/dlq";

export function DlqScreen({
  view,
  resolveAction,
  retryAction,
}: {
  view: AdminDlqView;
  resolveAction: (failureId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  retryAction: (outboxMessageId: string, failureId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
}) {
  return (
    <main className="mx-auto w-full max-w-2xl p-8">
      <h1 className="text-xl font-bold">처리 실패 (미처리)</h1>
      <p className="mt-2 text-sm text-gray-500">
        결제 웹훅 처리 실패, 아웃박스(권한부여) 처리 실패, 무결성 점검 경고 등 비동기 처리 중 발생한 오류 건들입니다. 신청자에게 직접 연락하거나, 확인 후 수동으로 처리해 주세요.
      </p>

      {view.failures.length === 0 ? (
        <p className="mt-6 text-sm text-gray-400">미처리 에러가 없습니다.</p>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {view.failures.map((failure) => (
            <li key={failure.id} className="rounded border p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{failure.source}</span>
                <span className="text-xs text-gray-400">{failure.createdText}</span>
              </div>
              <p className="mt-2 text-red-600">{failure.errorMessage}</p>
              <pre className="mt-2 overflow-x-auto rounded bg-gray-50 p-2 text-xs">{failure.payloadJson}</pre>
              {failure.outboxNote && <p className="mt-2 text-xs text-gray-500">{failure.outboxNote}</p>}
              {failure.outboxMessageId && (
                <ActionForm
                  action={retryAction.bind(null, failure.outboxMessageId, failure.id)}
                  className="mt-2 flex items-center gap-2"
                >
                  <Input name="reason" type="text" required placeholder="재시도 사유" className="h-8 text-xs" />
                  <ActionFormSubmitButton className="text-green-600 underline disabled:text-gray-400">
                    재시도
                  </ActionFormSubmitButton>
                  <ActionFormError className="mt-1 text-xs text-red-600" />
                </ActionForm>
              )}
              <ActionForm action={resolveAction.bind(null, failure.id)} className="mt-2 flex items-center gap-2">
                <Input name="reason" type="text" required placeholder="처리 사유" className="h-8 text-xs" />
                <ActionFormSubmitButton className="text-blue-600 underline disabled:text-gray-400">
                  처리 완료로 표시
                </ActionFormSubmitButton>
                <ActionFormError className="mt-1 text-xs text-red-600" />
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
