"use client";

import type { ActionResult } from "@/lib/errors";
import { Modal } from "@/ui/forms/Modal";
import { ActionForm, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { ResultDialog } from "@/ui/forms/ResultDialog";
import { useResultAction } from "@/ui/forms/useResultAction";
import { Input } from "@/ui/shadcn/input";

export type OfferingAction = (
  offeringId: string,
  prev: ActionResult<string> | null,
  fd: FormData,
) => Promise<ActionResult<string>>;

// 개설강의 폐강 컨트롤(폐강 시작 / 폐강 마무리 확인):
// 상태 변경 시 하위 모달 컴포넌트가 언마운트되더라도 처리 결과는 이 상위 컴포넌트가 받아 `<ResultDialog>`로 안내한다.
export function OfferingCancelControls({
  offeringId,
  status,
  courseName,
  label,
  cancelAction,
  completeAction,
  revokeAction,
  completeBlockedText = null,
}: {
  offeringId: string;
  status: string;
  courseName: string | null;
  label: string | null;
  cancelAction: OfferingAction;
  completeAction: OfferingAction;
  revokeAction?: OfferingAction;
  /** 처리 안 된 수강생이 있어 폐강 마무리를 못 할 때의 이유(상세 화면이 넘긴다). 목록 화면은 모르므로 null — 서버가 최종 판정한다. */
  completeBlockedText?: string | null;
}) {
  const cancel = useResultAction(cancelAction.bind(null, offeringId));
  const complete = useResultAction(completeAction.bind(null, offeringId));
  const revoke = useResultAction(revokeAction ? revokeAction.bind(null, offeringId) : async () => ({ ok: false, message: "" }));

  const done = cancel.result ?? complete.result ?? (revokeAction ? revoke.result : null);

  return (
    <>
      {(status === "OPEN" || status === "CLOSED") && (
        <Modal triggerLabel="폐강" title="개설강의를 폐강할까요?">
          <ActionForm action={cancel.action} closeModalOnDone className="flex flex-col gap-3">
            <p className="rounded-sm bg-orange-50 px-3 py-2 text-sm font-medium text-orange-900">
              폐강 대상: {courseName}
              {label ? ` (${label})` : ""}
            </p>
            <p className="text-sm text-gray-600">
              폐강하면 모집이 멈추고 결제 전 신청은 정리됩니다. 결제 완료·무료(직권 부여) 수강생은 자동으로
              환불·종료되지 않습니다 — 폐강 뒤 개설강의 상세의 「수강생 처리」에서 학생별로 전액 환불하거나
              환불 없이 종료한 다음, 모두 처리되면 폐강 마무리를 누릅니다. 모집 마감 상태에서도 폐강할 수 있습니다.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              폐강 사유(필수)
              <Input
                name="reason"
                required
                placeholder="폐강 사유"
              />
            </label>
            <ActionFormSubmitButton variant="destructive" className="self-start">
              폐강 확정
            </ActionFormSubmitButton>
          </ActionForm>
        </Modal>
      )}
      {status === "CANCELLING" && (
        <div className="flex items-center gap-2">
          <ActionForm action={complete.action} className="flex items-center gap-1">
            <ActionFormSubmitButton
              disabled={completeBlockedText !== null}
              className="text-xs text-orange-700 underline disabled:text-gray-400"
            >
              폐강 마무리 확인
            </ActionFormSubmitButton>
            {completeBlockedText && <span className="text-xs text-gray-500">{completeBlockedText}</span>}
          </ActionForm>
          {revokeAction && (
            <Modal triggerLabel="폐강 철회" title="폐강을 철회할까요?">
              <ActionForm action={revoke.action} closeModalOnDone className="flex flex-col gap-3">
                <p className="text-sm text-gray-600">
                  폐강을 철회하면 개설강의 상태가 다시 활성화됩니다. 이미 환불 처리되거나 정리된 신청은 자동으로 복구되지 않습니다.
                </p>
                <label className="flex flex-col gap-1 text-sm">
                  철회 사유(필수)
                  <Input name="reason" required placeholder="폐강 철회 사유" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  복귀 상태
                  <select name="targetStatus" defaultValue="CLOSED" className="h-8 rounded border px-2 text-xs">
                    <option value="CLOSED">CLOSED (마감 유지)</option>
                    <option value="OPEN">OPEN (모집 재개)</option>
                  </select>
                </label>
                <ActionFormSubmitButton className="self-start">
                  철회 확정
                </ActionFormSubmitButton>
              </ActionForm>
            </Modal>
          )}
        </div>
      )}
      {status === "CANCELLED" && revokeAction && (
        <Modal triggerLabel="폐강 철회" title="폐강을 철회할까요?">
          <ActionForm action={revoke.action} closeModalOnDone className="flex flex-col gap-3">
            <p className="text-sm text-gray-600">
              폐강 완료된 강의를 철회하여 다시 활성화합니다. 이미 환불 처리되거나 종료된 주문은 변경되지 않으며, 필요 시 새로운 수강 신청을 받아야 합니다.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              철회 사유(필수)
              <Input name="reason" required placeholder="폐강 철회 사유" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              복귀 상태
              <select name="targetStatus" defaultValue="CLOSED" className="h-8 rounded border px-2 text-xs">
                <option value="CLOSED">CLOSED (마감 유지)</option>
                <option value="OPEN">OPEN (모집 재개)</option>
              </select>
            </label>
            <ActionFormSubmitButton className="self-start">
              철회 확정
            </ActionFormSubmitButton>
          </ActionForm>
        </Modal>
      )}
      {done && (
        <ResultDialog
          ok={done.ok}
          message={done.ok ? (typeof done.data === "string" ? done.data : "처리되었습니다.") : done.message}
          onClose={() => {
            cancel.clear();
            complete.clear();
            if (revokeAction) revoke.clear();
          }}
        />
      )}
    </>
  );
}
