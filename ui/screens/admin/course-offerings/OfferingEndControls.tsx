"use client";

import type { ActionResult } from "@/lib/errors";
import { Modal } from "@/ui/forms/Modal";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { ResultDialog } from "@/ui/forms/ResultDialog";
import { useResultAction } from "@/ui/forms/useResultAction";
import { Input } from "@/ui/shadcn/input";

export type OfferingEndAction = (
  offeringId: string,
  prev: ActionResult<string> | null,
  fd: FormData,
) => Promise<ActionResult<string>>;

// 강의 종료 / 종료 취소 컨트롤(ADR-0022). 개설강의 상세 「작업」에서만 쓴다. 종료는 종강일이 지난(또는 종강일 없이 개강한) 강의만,
// 종료 취소는 종료된 강의만 보인다 — 폐강(취소)과 다른 일이다. 결과는 닫혀도 남는 이 컴포넌트가 ResultDialog로 알린다(성공 뒤 revalidate로
// 버튼이 바뀌어도 알림이 사라지지 않게, OfferingCancelControls와 같은 이유).
export function OfferingEndControls({
  offeringId,
  title,
  canEnd,
  canCancelEnd,
  openRefundRequestCount = 0,
  endAction,
  cancelEndAction,
}: {
  offeringId: string;
  title: string;
  canEnd: boolean;
  canCancelEnd: boolean;
  openRefundRequestCount?: number;
  endAction: OfferingEndAction;
  cancelEndAction: OfferingEndAction;
}) {
  const end = useResultAction(endAction.bind(null, offeringId));
  const cancelEnd = useResultAction(cancelEndAction.bind(null, offeringId));
  const done = end.result ?? cancelEnd.result;

  return (
    <>
      {canEnd && (
        <Modal triggerLabel="강의 종료" title="강의를 종료할까요?">
          <ActionForm action={end.action} closeModalOnDone className="flex flex-col gap-3">
            <p className="rounded-sm bg-orange-50 px-3 py-2 text-sm font-medium text-orange-900">종료 대상: {title}</p>
            {openRefundRequestCount > 0 && (
              <p className="rounded-sm bg-amber-50 border border-amber-200 px-3 py-2 text-xs font-semibold text-amber-900">
                ⚠️ 처리되지 않은 수강생 환불 신청이 {openRefundRequestCount}건 있습니다. 강의를 종료해도 환불 신청은 사라지지 않으며 주문 상세에서 계속 처리할 수 있습니다.
              </p>
            )}
            <p className="text-sm text-gray-600">
              종료하면 이 강의의 <b>모든 수강생의 이용권·디스코드 역할이 회수</b>됩니다(환불과 무관, 주문·결제 상태는 그대로). 결제 전 신청은 정리됩니다.
              종료 후에도 환불은 주문 상세에서 할 수 있고, 잘못 종료했다면 「종료 취소」로 이용권을 다시 부여할 수 있습니다(종료 때 정리된 결제 전 신청은 되살리지 못합니다).
              기간 중 중단은 종료가 아니라 폐강을 쓰세요.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              종료 비고(필수)
              <Input name="note" required placeholder="예: 정상 강의 완료" />
            </label>
            <ActionFormSubmitButton variant="destructive" className="self-start">
              종료 확정
            </ActionFormSubmitButton>
            <ActionFormError className="text-xs text-red-600" />
          </ActionForm>
        </Modal>
      )}
      {canCancelEnd && (
        <Modal triggerLabel="종료 취소" title="강의 종료를 취소할까요?">
          <ActionForm action={cancelEnd.action} closeModalOnDone className="flex flex-col gap-3">
            <p className="text-sm text-gray-600">
              종료 기록을 지우고 <b>승인된 수강생의 이용권을 새로 다시 부여</b>합니다(옛 회수 기록은 이력으로 남습니다). 「수동 종료」 설정이 켜져 다시 자동 종료되지
              않습니다. 종료 때 정리된 결제 전 신청과, 종료 뒤 환불·탈퇴로 취소된 주문은 되살아나지 않습니다. 새로 부여되는 이용권은 다운로드 횟수와 유효 기간이 지금부터 새로 시작합니다. 원래 종료 일시·비고는 각 주문 기록과 감사 기록에 남습니다.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              종료 취소 사유(필수)
              <Input name="reason" required placeholder="예: 종강일 입력 오류" />
            </label>
            <ActionFormSubmitButton variant="destructive" className="self-start">
              종료 취소 확정
            </ActionFormSubmitButton>
            <ActionFormError className="text-xs text-red-600" />
          </ActionForm>
        </Modal>
      )}
      {done && (
        <ResultDialog
          ok={done.ok}
          message={done.ok ? (typeof done.data === "string" ? done.data : "처리되었습니다.") : done.message}
          onClose={() => {
            end.clear();
            cancelEnd.clear();
          }}
        />
      )}
    </>
  );
}
