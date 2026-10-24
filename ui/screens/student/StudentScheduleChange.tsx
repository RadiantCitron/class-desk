"use client";

import type { ActionResult } from "@/lib/errors";
import { Modal } from "@/ui/forms/Modal";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { ResultDialog } from "@/ui/forms/ResultDialog";
import { useResultAction } from "@/ui/forms/useResultAction";
import { Textarea } from "@/ui/shadcn/textarea";

export type RequestRefundAction = (
  orderId: string,
  prev: ActionResult<string> | null,
  fd: FormData,
) => Promise<ActionResult<string>>;

type Change = {
  noticeId: string;
  status: "NOTIFIED" | "REFUND_REQUESTED" | "LEGACY_ACCEPTED" | "LEGACY_DECLINED";
  reason: string;
  beforeText: string;
  afterText: string;
  changedLines?: string;
};

// 일정 변경 안내(단순화). 수강생에게 일정을 고지하며, 변경된 일정으로 수강이 어려울 경우 「이 변경으로 환불 신청」을 할 수 있다.
// 동의/미동의 응답 체계는 해체되었으며, 신청하지 않으면 수강이 그대로 유지된다.
export function StudentScheduleChange({
  orderId,
  courseText,
  change,
  canRequestRefund,
  requestRefundAction,
}: {
  orderId: string;
  courseText: string;
  change: Change;
  canRequestRefund: boolean;
  requestRefundAction: RequestRefundAction;
}) {
  const refund = useResultAction(requestRefundAction.bind(null, orderId));

  return (
    <div className="mt-1 w-full rounded-sm border border-orange-200 bg-orange-50 p-2 text-xs text-orange-950" data-testid="schedule-change-notice">
      <p className="font-medium">일정이 변경되었습니다{change.reason ? ` — ${change.reason}` : ""}</p>
      <p className="mt-1">
        이전: <span data-testid="schedule-before">{change.beforeText}</span>
      </p>
      <p>
        변경: <span data-testid="schedule-after">{change.afterText}</span>
      </p>
      {change.changedLines && (
        <p className="mt-1 text-gray-700">
          요약: <span className="font-medium">{change.changedLines}</span>
        </p>
      )}

      {change.status === "NOTIFIED" && (
        <>
          <p className="mt-1 text-gray-700">
            일정이 바뀌었습니다. 변경된 일정이 어렵다면 환불을 신청해 주세요. 환불 금액은 약관의 환불 기준에 따라 관리자가 확인한 뒤 안내드립니다(자동으로 환불되지 않습니다).
          </p>
          {canRequestRefund && (
            <div className="mt-2">
              <Modal triggerLabel="이 변경으로 환불 신청" title="일정 변경으로 인한 환불 신청">
                <ActionForm action={refund.action} closeModalOnDone className="flex flex-col gap-3">
                  <input type="hidden" name="scheduleChangeNoticeId" value={change.noticeId} />
                  <p className="rounded-sm bg-orange-50 px-3 py-2 text-sm font-medium text-orange-900">{courseText}</p>
                  <p className="text-sm text-gray-600">
                    일정 변경 사유로 환불을 신청합니다. 관리자가 신청 시점의 약관 기준을 확인한 뒤 환불을 처리합니다.
                  </p>
                  <label className="flex flex-col gap-1 text-sm">
                    환불 사유(필수)
                    <Textarea
                      name="reason"
                      required
                      rows={2}
                      defaultValue="일정 변경으로 인한 수강 불가"
                      placeholder="사유를 입력해 주세요"
                    />
                  </label>
                  <ActionFormSubmitButton variant="destructive" className="self-start">
                    환불 신청 확정
                  </ActionFormSubmitButton>
                  <ActionFormError className="text-xs text-red-600" />
                </ActionForm>
              </Modal>
            </div>
          )}
        </>
      )}

      {change.status === "REFUND_REQUESTED" && (
        <p className="mt-1 font-medium text-blue-800" data-testid="schedule-change-refund-requested">
          일정 변경으로 환불을 신청했습니다 — 관리자가 검토 중입니다.
        </p>
      )}
      {change.status === "LEGACY_ACCEPTED" && (
        <p className="mt-1 font-medium text-green-800" data-testid="schedule-change-accepted">
          변경된 일정에 동의했습니다 (과거 기록).
        </p>
      )}
      {change.status === "LEGACY_DECLINED" && (
        <p className="mt-1 font-medium text-red-700" data-testid="schedule-change-declined">
          동의하지 않음으로 응답했습니다 (과거 기록).
        </p>
      )}
      {refund.result && (
        <ResultDialog
          ok={refund.result.ok}
          message={refund.result.ok ? (typeof refund.result.data === "string" ? refund.result.data : "신청했습니다.") : refund.result.message}
          onClose={refund.clear}
        />
      )}
    </div>
  );
}
