"use client";

import { useState } from "react";
import type { ActionResult } from "@/lib/errors";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { Modal } from "@/ui/forms/Modal";
import { ResultDialog } from "@/ui/forms/ResultDialog";
import { useResultAction } from "@/ui/forms/useResultAction";
import { radioClass } from "@/ui/forms/controls";
import { Button } from "@/ui/shadcn/button";
import { Textarea } from "@/ui/shadcn/textarea";

// 현재 선택 가능한 PG는 토스뿐(페이앱은 2026-10-02 폐기). 새 PG는 이 유니언·라디오 한 개·키 설정 여부 prop 한 개를 추가한다.
type ProviderChoice = "TOSS" | null;

const providerLabel = (p: ProviderChoice) => (p === null ? "미설정(결제 차단)" : p);

export type SetProviderAction = (
  provider: string | null,
  prevState: ActionResult<string> | null,
  formData: FormData,
) => Promise<ActionResult<string>>;

// 활성 PG 선택. SystemGatePanel과 같이 사유 필수.
// 키 존재 여부만 서버에서 받아 버튼을 비활성화한다(값 자체는 클라이언트에 안 내려보낸다).
//
// PG를 바꾸면 모든 학생 결제에 즉시 적용되므로 ① 저장 전에 "무엇에서 무엇으로
// 바꾸는지" 확인 모달을 거치고(사유도 그 안에서 입력) ② 저장 뒤에는 결과 팝업이 변경 내용을 알린다.
// 결과는 모달/폼이 아니라 이 패널이 받는다(components/useResultAction.ts — 폼이 사라져도 팝업은 남는다).
export function PaymentProviderPanel({
  current,
  reason,
  changedAt,
  changedByEmail,
  tossKeysConfigured,
  setProviderAction,
}: {
  current: ProviderChoice;
  reason: string | null;
  changedAt: string | null;
  changedByEmail: string | null;
  tossKeysConfigured: boolean;
  setProviderAction: SetProviderAction;
}) {
  const [selected, setSelected] = useState<ProviderChoice>(current);
  const submit = useResultAction(setProviderAction.bind(null, selected));

  const tossDisabled = !tossKeysConfigured;
  const unchanged = selected === current;
  const disabled = unchanged || (selected === "TOSS" && tossDisabled);

  return (
    <section className="mt-10 rounded-sm border border-gray-200 p-4">
      <h2 className="text-base font-bold">결제 PG</h2>
      <p className="mt-1 text-sm text-gray-500">
        학생이 결제할 때 쓰는 결제대행사입니다. 미설정이면 결제 시작이 막힙니다.
      </p>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-500">현재</dt>
        <dd className="font-medium">{current ?? "미설정"}</dd>
        <dt className="text-gray-500">사유</dt>
        <dd className="text-gray-700">{reason ?? "-"}</dd>
        <dt className="text-gray-500">변경자</dt>
        <dd className="font-mono text-xs text-gray-500">{changedByEmail ?? "-"}</dd>
        <dt className="text-gray-500">변경 시각</dt>
        <dd className="text-xs text-gray-400">
          {changedAt ?? "-"}
        </dd>
      </dl>

      <fieldset className="mt-4 flex flex-col gap-2 text-sm">
        <legend className="mb-1 font-medium">변경할 PG</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="provider_ui"
            checked={selected === null}
            onChange={() => setSelected(null)}
            className={radioClass}
          />
          미설정 (결제 차단)
        </label>
        <label className={`flex items-center gap-2 ${tossDisabled ? "text-gray-400" : ""}`}>
          <input
            type="radio"
            name="provider_ui"
            checked={selected === "TOSS"}
            disabled={tossDisabled}
            onChange={() => setSelected("TOSS")}
            className={radioClass}
          />
          토스페이먼츠 (TOSS)
        </label>
        {tossDisabled && (
          <p className="pl-6 text-xs text-amber-700">
            토스 PG의 키가 설정되지 않았습니다(운영자에게 문의).
          </p>
        )}
      </fieldset>

      {unchanged ? (
        <p className="mt-3 text-xs text-gray-500">현재와 같은 값입니다. 다른 PG를 고르면 변경할 수 있습니다.</p>
      ) : null}

      <div className="mt-3">
        {disabled ? (
          <Button
            type="button"
            disabled
          >
            PG 설정 저장
          </Button>
        ) : (
          // key: 선택이 바뀌면 모달 인스턴스를 새로 만들어, 열려 있던 확인 문구가 이전 선택 그대로 남지 않게 한다.
          <Modal key={String(selected)} triggerLabel="PG 설정 저장" title="결제 PG를 변경할까요?">
            <ActionForm action={submit.action} closeModalOnDone className="flex flex-col gap-3">
              <p className="text-sm text-gray-700">
                결제 PG를 <strong>{providerLabel(current)}</strong> →{" "}
                <strong>{providerLabel(selected)}</strong>(으)로 바꿉니다.
              </p>
              <p className="text-xs text-amber-700">
                모든 학생의 결제에 즉시 적용됩니다. 변경은 감사 로그에 남고 지울 수 없습니다.
              </p>
              <label className="flex flex-col gap-1 text-sm">
                변경 사유(필수)
                <Textarea
                  name="reason"
                  required
                  rows={3}
                  placeholder="예: 오픈 전 토스로 전환"
                />
              </label>
              <ActionFormError />
              <ActionFormSubmitButton variant="default" className="self-start">
                변경 확정
              </ActionFormSubmitButton>
            </ActionForm>
          </Modal>
        )}
      </div>

      {submit.result && (
        <ResultDialog
          ok={submit.result.ok}
          message={
            submit.result.ok
              ? typeof submit.result.data === "string"
                ? submit.result.data
                : "처리되었습니다."
              : submit.result.message
          }
          onClose={submit.clear}
        />
      )}
    </section>
  );
}
