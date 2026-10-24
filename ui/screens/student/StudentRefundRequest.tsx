"use client";

import type { ActionResult } from "@/lib/errors";
import { Modal } from "@/ui/forms/Modal";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { ResultDialog } from "@/ui/forms/ResultDialog";
import { useResultAction } from "@/ui/forms/useResultAction";
import { Textarea } from "@/ui/shadcn/textarea";

export type RequestRefundAction = (orderId: string, prev: ActionResult<string> | null, fd: FormData) => Promise<ActionResult<string>>;

// 수강생 환불 신청 — **신청만 한다.** 신청해도 자동으로 환불되지 않고 관리자가 검토해 처리한다. 버튼이 켜져 있어도
// 서버가 약관 기준을 다시 계산해 자격이 안 되면 결과 팝업(실패)으로 안내한다. 결과는 닫혀도 남는 이 컴포넌트가 ResultDialog로 알린다.
export function StudentRefundRequest({
  orderId,
  courseText,
  refund,
  requestAction,
}: {
  orderId: string;
  courseText: string;
  /** AVAILABLE이면 신청 버튼, REQUESTED면 신청됨 문구. 신청이 성공해 화면이 갱신되면 AVAILABLE → REQUESTED로 바뀌지만 이 컴포넌트는 계속 마운트돼
   *  결과 팝업이 사라지지 않는다(버튼 컴포넌트가 통째로 빠지면 성공 팝업도 같이 사라져 「성공했는데 아무 말 없는」 화면이 된다 — useResultAction 주석). */
  refund: { kind: "AVAILABLE"; proposalText: string; auto?: boolean } | { kind: "REQUESTED"; text: string };
  requestAction: RequestRefundAction;
}) {
  const request = useResultAction(requestAction.bind(null, orderId));
  const isAuto = refund.kind === "AVAILABLE" && refund.auto === true;
  return (
    <>
      {refund.kind === "REQUESTED" && (
        <span className="text-xs text-blue-700" data-testid="refund-requested">
          {refund.text}
        </span>
      )}
      {refund.kind === "AVAILABLE" && (
      <Modal triggerLabel={isAuto ? "환불하기" : "환불 신청"} title={isAuto ? "환불을 진행할까요?" : "환불을 신청할까요?"}>
        <ActionForm action={request.action} closeModalOnDone className="flex flex-col gap-3">
          <p className="rounded-sm bg-orange-50 px-3 py-2 text-sm font-medium text-orange-900">{courseText}</p>
          <p className="text-sm text-gray-600" data-testid="refund-proposal-text">
            {refund.proposalText}
          </p>
          <p className="text-xs text-gray-500">
            {isAuto
              ? "약관 기준 환불액이 바로 결제 수단으로 환불 요청되며, 수강 권한(이용권·디스코드 역할)이 회수되고 신청이 종료됩니다. 되돌릴 수 없습니다."
              : "신청하면 자동으로 환불되지 않고 관리자가 검토한 뒤 처리합니다. 환불이 이루어지면 이 신청은 종료되고 수강 권한(이용권·디스코드 역할)이 회수됩니다. 신청한 뒤에는 취소할 수 없습니다."}
          </p>
          <label className="flex flex-col gap-1 text-sm">
            환불 사유(필수)
            <Textarea name="reason" required rows={3} maxLength={1000} placeholder="예: 개인 사정으로 수강이 어렵습니다" />
          </label>
          <ActionFormSubmitButton variant="destructive" className="self-start">
            {isAuto ? "환불 요청 확정" : "환불 신청 확정"}
          </ActionFormSubmitButton>
          <ActionFormError className="text-xs text-red-600" />
        </ActionForm>
      </Modal>
      )}
      {request.result && (
        <ResultDialog
          ok={request.result.ok}
          message={request.result.ok ? (typeof request.result.data === "string" ? request.result.data : "신청했습니다.") : request.result.message}
          onClose={request.clear}
        />
      )}
    </>
  );
}
