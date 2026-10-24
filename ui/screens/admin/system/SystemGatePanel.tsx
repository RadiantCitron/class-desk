"use client";

import type { ActionResult } from "@/lib/errors";
import { Modal } from "@/ui/forms/Modal";
import { ResultDialog } from "@/ui/forms/ResultDialog";
import { useResultAction } from "@/ui/forms/useResultAction";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { Textarea } from "@/ui/shadcn/textarea";

export type SetGateAction = (
  code: string,
  status: "OPEN" | "CLOSED",
  prevState: ActionResult | null,
  formData: FormData,
) => Promise<ActionResult>;

// 게이트 1개의 상태 전환 컨트롤. 봉쇄(CLOSED)·해제(OPEN) 둘 다 영향이 크므로 사유 입력을
// 강제하고 확인 모달(components/Modal.tsx — 배경 클릭·ESC로 닫히지 않는 확인 필수 창)을 거치게 한다
// (예전엔 해제는 확인 없이 바로 처리했다).
//
// ① 클라이언트 컴포넌트 — 결과를 부모(이 컴포넌트)가 받아 ResultDialog로 알린다.
// ② 상태가 바뀌면 key가 달라져 모달 인스턴스가 새로 만들어진다 — 같은 자리에 같은 타입의 Modal을 두면
// React가 같은 <dialog>를 재사용해 "열린 채 제목만 해제↔봉쇄로 바뀌는" 현상이 있었다.
export function SystemGatePanel({
  code,
  label,
  status,
  setGateAction,
}: {
  code: string;
  label: string;
  status: "OPEN" | "CLOSED";
  setGateAction: SetGateAction;
}) {
  const closing = useResultAction(setGateAction.bind(null, code, "CLOSED"));
  const opening = useResultAction(setGateAction.bind(null, code, "OPEN"));

  const done = closing.result
    ? { kind: "CLOSED" as const, result: closing.result }
    : opening.result
      ? { kind: "OPEN" as const, result: opening.result }
      : null;
  const message = !done
    ? ""
    : !done.result.ok
      ? done.result.message
      : done.kind === "CLOSED"
        ? `${label} 기능을 봉쇄했습니다.`
        : `${label} 기능의 봉쇄를 해제했습니다.`;

  return (
    <>
      {status === "CLOSED" ? (
        <Modal key={status} triggerLabel="해제" title="정말 해제합니까?">
          <ActionForm action={opening.action} closeModalOnDone className="flex flex-col gap-3">
            <p className="text-sm text-gray-600">지금부터 이 기능이 다시 열립니다.</p>
            <label className="flex flex-col gap-1 text-sm">
              해제 사유(필수)
              <Textarea
                name="reason"
                required
                rows={3}
                placeholder="예: PG사 점검 종료 확인"
              />
            </label>
            <ActionFormError />
            <ActionFormSubmitButton variant="default" className="self-start">
              해제 확정
            </ActionFormSubmitButton>
          </ActionForm>
        </Modal>
      ) : (
        <Modal key={status} triggerLabel="봉쇄" title="정말 봉쇄합니까?">
          <ActionForm action={closing.action} closeModalOnDone className="flex flex-col gap-3">
            <p className="text-sm text-gray-600">
              지금부터 이 기능을 이용하려는 시도가 관리자 포함 전부 차단됩니다. 이 화면의 해제는
              봉쇄 중에도 할 수 있습니다.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              봉쇄 사유(필수)
              <Textarea
                name="reason"
                required
                rows={3}
                placeholder="예: PG사 점검, 결제 오류 조사 중"
              />
            </label>
            <ActionFormError />
            <ActionFormSubmitButton variant="destructive" className="self-start">
              봉쇄 확정
            </ActionFormSubmitButton>
          </ActionForm>
        </Modal>
      )}
      {done && (
        <ResultDialog
          ok={done.result.ok}
          message={message}
          onClose={() => {
            closing.clear();
            opening.clear();
          }}
        />
      )}
    </>
  );
}
