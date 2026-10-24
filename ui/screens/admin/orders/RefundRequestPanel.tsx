"use client";

import type { ActionResult } from "@/lib/errors";
import type { RefundRequestView } from "@/ui/views/admin/order-detail";
import { Modal } from "@/ui/forms/Modal";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { ResultDialog } from "@/ui/forms/ResultDialog";
import { useResultAction } from "@/ui/forms/useResultAction";
import { Textarea } from "@/ui/shadcn/textarea";

type OrderAction = (orderId: string, prev: ActionResult<string> | null, fd: FormData) => Promise<ActionResult<string>>;

// 수강생의 환불 신청 — 열린 신청이 있을 때만 보인다. 환불은 바로 아래 환불 패널의 기존 「환불 요청」 버튼으로 하고(제안 금액을
// 보고 조정), 환불하지 않으려면 여기서 사유를 적어 거절한다. 거절해도 관리자는 직권으로 환불할 수 있다. 메일·알림은 없다 — 수강생은 홈에서 거절 사유를 본다.
export function RefundRequestPanel({
  orderId,
  request,
  rejectAction,
}: {
  orderId: string;
  request: RefundRequestView;
  rejectAction: OrderAction;
}) {
  const reject = useResultAction(rejectAction.bind(null, orderId));
  const tone = request.level === "ALERT" ? "text-red-700" : request.level === "WARN" ? "text-amber-700" : "text-blue-800";
  return (
    <div className="mt-6 rounded-sm border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950" data-testid="student-refund-request">
      <p className="font-medium flex flex-wrap items-center gap-1.5">
        <span>수강생 환불 신청{request.requestedOn ? ` (${request.requestedOn})` : ""}</span> · <span className={tone}>{request.ageText}</span>
        {request.isNotAllowedSection && (
          <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-800" data-testid="refund-not-allowed-badge">
            약관상 불가 구간 신청
          </span>
        )}
      </p>
      <p className="mt-1">
        사유: <span data-testid="student-refund-reason">{request.reason}</span>
      </p>
      {request.atRequestText && <p className="mt-1 text-xs">{request.atRequestText}</p>}
      {request.currentText && <p className="mt-1 text-xs">{request.currentText}</p>}
      <p className="mt-2 text-xs text-gray-600">
        신청만 접수된 상태입니다. 아래 환불 패널에서 금액을 정해 환불하거나, 환불하지 않으려면 사유를 적어 거절하세요. 어느 기준의 금액으로 환불할지는 관리자가 정합니다.
      </p>
      <div className="mt-3">
        <Modal triggerLabel="신청 거절" title="환불 신청을 거절할까요?">
          <ActionForm action={reject.action} closeModalOnDone className="flex flex-col gap-3">
            <p className="text-sm text-gray-600">
              거절하면 수강생에게 사유가 보이고 다시 신청할 수 있습니다. 거절해도 이 주문은 그대로 유지되며, 필요하면 관리자가 직권으로 환불할 수 있습니다.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              거절 사유(필수)
              <Textarea name="reason" required rows={2} placeholder="예: 개강이 임박해 약관 기준으로 환불 대상이 아닙니다" />
            </label>
            <ActionFormSubmitButton variant="destructive" className="self-start">
              신청 거절 확정
            </ActionFormSubmitButton>
            <ActionFormError className="text-xs text-red-600" />
          </ActionForm>
        </Modal>
      </div>
      {reject.result && (
        <ResultDialog
          ok={reject.result.ok}
          message={reject.result.ok ? (typeof reject.result.data === "string" ? reject.result.data : "처리되었습니다.") : reject.result.message}
          onClose={reject.clear}
        />
      )}
    </div>
  );
}
