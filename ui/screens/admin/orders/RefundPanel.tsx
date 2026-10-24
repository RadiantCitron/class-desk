"use client";

import type { ActionResult } from "@/lib/errors";
import { Modal } from "@/ui/forms/Modal";
import { ActionForm, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { ResultDialog } from "@/ui/forms/ResultDialog";
import { useResultAction } from "@/ui/forms/useResultAction";
import { radioClass } from "@/ui/forms/controls";
import { Input } from "@/ui/shadcn/input";
import { NativeSelect, NativeSelectOption } from "@/ui/shadcn/native-select";
import { Textarea } from "@/ui/shadcn/textarea";
import type { AmountDefaultView, RefundProposalView, SnapshotView } from "@/ui/views/admin/order-detail";


const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CARD: "카드",
  BANK_TRANSFER: "계좌이체",
  OTHER: "기타",
};

export type OpenRefundRequest = {
  id: string;
  amount: number;
  createdText: string;
  stale: boolean;
};

export type OrderAction = (
  orderId: string,
  prevState: ActionResult<string> | null,
  formData: FormData,
) => Promise<ActionResult<string>>;

/**
 * PG 외 환불의 환불 수단(R-4, 2026-10-02) — 예전에는 항상 계좌이체로 기록돼, 카드(PG) 취소를 반영해도
 * 원장에 `BANK_TRANSFER`가 남았다. 원결제 수단을 아는 주문이면 "원결제와 같은 수단"을 기본으로 준다.
 */
function RefundMethodSelect({ originalPaymentMethod }: { originalPaymentMethod: string | null }) {
  const original = originalPaymentMethod ? PAYMENT_METHOD_LABEL[originalPaymentMethod] : undefined;
  return (
    <label className="flex flex-col gap-1 text-sm">
      환불 수단(원장에 기록됩니다)
      <NativeSelect
        name="refundMethod"
        defaultValue={original ? "ORIGINAL" : "BANK_TRANSFER"}
      >
        {original && <NativeSelectOption value="ORIGINAL">원결제와 같은 수단 ({original})</NativeSelectOption>}
        <NativeSelectOption value="BANK_TRANSFER">계좌이체</NativeSelectOption>
        <NativeSelectOption value="OTHER">기타</NativeSelectOption>
      </NativeSelect>
    </label>
  );
}

/** 관리자 주문 상세 — 환불 개시·열린 요청 출구. */
export function RefundPanel({
  originalPaymentMethod,
  proposal,
  requestSnapshot,
  amountDefault,
  orderId,
  refundableAmount,
  requestKey,
  formKey,
  openRequest,
  isOrphanPayment,
  orphanKind,
  digitalConsumed,
  refundAction,
  markFailedAction,
  manualRefundAction,
}: {
  originalPaymentMethod: string | null;
  /** 약관 기준 환불 제안 — 없으면 null. 제안일 뿐 환불을 막지 않는다. */
  proposal: RefundProposalView | null;
  /** 수강생 신청 시점 제안 스냅샷. */
  requestSnapshot?: SnapshotView | null;
  /** 승인 화면 기본 환불 모드와 금액. */
  amountDefault?: AmountDefaultView;
  orderId: string;
  refundableAmount: number;
  requestKey: string;
  formKey: string;
  openRequest: OpenRefundRequest | null;
  isOrphanPayment: boolean;
  orphanKind?: "UNPAID_ORPHAN" | "CLOSED_ORDER" | null;
  digitalConsumed: boolean;
  refundAction: OrderAction;
  markFailedAction: OrderAction;
  manualRefundAction: OrderAction;
}) {


  // 결과(성공·실패)는 폼이 아니라 이 패널이 받는다 — 환불 요청이 성공하면 revalidate로 "PG 처리 중" 분기로
  // 바뀌어 환불 모달(ActionForm)이 같은 렌더에서 사라지므로, 폼 안의 문구는 아무 말 없이 사라졌다
  //. 훅은 아래 early return보다 앞에 둔다(패널이 비어도 팝업은 남아야 한다).
  const request = useResultAction(refundAction.bind(null, orderId));
  const markFailed = useResultAction(markFailedAction.bind(null, orderId));
  const manual = useResultAction(manualRefundAction.bind(null, orderId));

  const done = request.result
    ? { kind: "request" as const, result: request.result }
    : markFailed.result
      ? { kind: "markFailed" as const, result: markFailed.result }
      : manual.result
        ? { kind: "manual" as const, result: manual.result }
        : null;
  const resultDialog = done ? (
    <ResultDialog
      ok={done.result.ok}
      message={
        done.result.ok
          ? [
              typeof done.result.data === "string" ? done.result.data : "처리되었습니다.",
              done.kind === "request"
                ? "PG 처리 결과는 통보(웹훅)로 반영됩니다. 이 화면을 새로고침해 확인하세요."
                : "",
            ]
              .filter(Boolean)
              .join("\n")
          : done.result.message
      }
      onClose={() => {
        request.clear();
        markFailed.clear();
        manual.clear();
      }}
    />
  ) : null;

  if (refundableAmount <= 0 && !openRequest) {
    return resultDialog;
  }

  return (
    <div className="mt-6 rounded-sm border p-4">
      <p className="text-sm font-medium">
        {orphanKind === "CLOSED_ORDER" ? "종결된 신청의 환불(결정 번복)" : "환불"}
      </p>
      {digitalConsumed && (
        <p className="mt-1 text-xs text-amber-800">
          이 주문에서 이미 다운로드한 파일이 있습니다. 환불은 가능하며, 다운로드 여부는 감사 기록에 남습니다.
        </p>
      )}
      {orphanKind === "CLOSED_ORDER" ? (
        <p className="mt-1 text-xs text-amber-800">
          이 신청은 이미 끝났습니다. 환불하면 돈만 돌려주고 수강·혜택은 되살리지 않습니다. 사유를 반드시 적으세요.
        </p>
      ) : isOrphanPayment ? (
        <p className="mt-1 text-xs text-amber-800">
          고아 결제(주문은 미결제 상태인데 원장에 결제 성공이 있음). 이 환불의 웹훅은 DLQ에
          &quot;이미 취소된 주문&quot;으로 남는 것이 정상입니다.
        </p>
      ) : null}

      {openRequest && (
        <div className="mt-3 rounded-sm border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p>
            PG 처리 중인 환불 요청 {openRequest.amount.toLocaleString()}원
            <span className="ml-1 text-xs text-amber-700">
              ({openRequest.createdText})
            </span>
          </p>
          {openRequest.stale && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Modal triggerLabel="요청 실패로 표시" title="요청 실패로 표시할까요?">
                <ActionForm action={markFailed.action} closeModalOnDone className="flex flex-col gap-3">
                  <p className="text-sm text-gray-600">
                    PG 콘솔에서 취소되지 않은 것을 확인한 뒤에만 사용하세요. 실패로 표시하면
                    새 환불 요청을 할 수 있습니다.
                  </p>
                  <label className="flex flex-col gap-1 text-sm">
                    사유(필수)
                    <Textarea
                      name="reason"
                      required
                      rows={2}
                      placeholder="예: PG 콘솔에서 취소 없음 확인"
                    />
                  </label>
                  <ActionFormSubmitButton variant="secondary" className="self-start">
                    실패로 표시
                  </ActionFormSubmitButton>
                </ActionForm>
              </Modal>

              <Modal triggerLabel="PG 외 환불 반영" title="PG 외 환불을 원장에 반영할까요?">
                <ActionForm action={manual.action} closeModalOnDone className="flex flex-col gap-3">
                  <p className="text-sm text-gray-600">
                    계좌이체 등으로 이미 돈을 돌려준 뒤에만 사용합니다. 금액은 열린 요청
                    {openRequest.amount.toLocaleString()}원입니다.
                  </p>
                  <input type="hidden" name="openRequestId" value={openRequest.id} />
                  <input
                    type="hidden"
                    name="openRequestAmount"
                    value={String(openRequest.amount)}
                  />
                  <RefundMethodSelect originalPaymentMethod={originalPaymentMethod} />
                  <label className="flex flex-col gap-1 text-sm">
                    사유(필수)
                    <Textarea
                      name="reason"
                      required
                      rows={2}
                      placeholder="예: 계좌이체 환불 완료, 2026-09-30"
                    />
                  </label>
                  <ActionFormSubmitButton variant="default" className="self-start">
                    원장 반영
                  </ActionFormSubmitButton>
                </ActionForm>
              </Modal>
            </div>
          )}
          {!openRequest.stale && (
            <p className="mt-2 text-xs text-amber-700">
              웹훅이 올 때까지 기다립니다. 60분이 지나면 위 출구 버튼이 나타납니다.
            </p>
          )}
        </div>
      )}

      {refundableAmount > 0 && !openRequest && (
        <>
          {/* 수강생 신청 시점 제안 */}
          {requestSnapshot && (
            <div
              className="mt-3 rounded-sm border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900"
              data-testid="request-snapshot-proposal"
            >
              <p className="font-medium">
                신청 시점 제안: {requestSnapshot.text}
              </p>
              {requestSnapshot.requestedOn && (
                <p className="mt-1 text-xs text-blue-700">신청일: {requestSnapshot.requestedOn}</p>
              )}
            </div>
          )}


          {/* 지금 다시 계산한 제안 (참고) */}
          {proposal && (
            <div
              className={`mt-3 rounded-sm border p-3 text-sm ${
                requestSnapshot ? "border-slate-200 bg-slate-50 text-slate-800" : proposal.eligible ? "border-blue-200 bg-blue-50 text-blue-900" : "border-gray-200 bg-gray-50 text-gray-700"
              }`}
              data-testid="refund-proposal"
            >
              <p className="font-medium">
                {requestSnapshot ? `지금 다시 계산한 제안 (참고): ${proposal.headline}` : proposal.headline}
              </p>
              <p className="mt-1 text-xs">{proposal.detail}</p>
              {proposal.policyNote && <p className="mt-1 text-xs text-amber-800">{proposal.policyNote}</p>}
              <p className="mt-1 text-xs text-gray-600">{proposal.notice}</p>
            </div>
          )}
          <p className="mt-1 text-xs text-gray-500">
            환불 가능액 {refundableAmount.toLocaleString()}원. 개시 직후는 &quot;요청됨&quot;이며,
            웹훅 반영 후 상태가 바뀝니다.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Modal triggerLabel="환불 요청" title="환불을 요청할까요?">
              <ActionForm action={request.action} closeModalOnDone className="flex flex-col gap-3">
                <input type="hidden" name="requestKey" value={requestKey} />
                {/* 전액/부분 선택은 React 상태가 아니라 브라우저 폼 값(라디오 name="mode")이 유일한 기준이다.
                    폼 액션이 끝나면 React 19가 폼을 리셋하는데, 별도 상태를 두면 화면(리셋된 라디오)과
                    상태가 어긋나 "전액"이 partial로 제출됐다. 안내 문구·금액칸 표시는
                    라디오 값에 따라 CSS(group-has)로만 바꾼다. */}
                <div className="group flex flex-col gap-3">
                  <p className="text-sm text-gray-600">
                    되돌릴 수 없습니다.{" "}
                    <span className="group-has-[input[value=partial]:checked]:hidden">
                      전액 환불 시 이용권이 회수되며, 이 강의는 다시 신청할 수 없습니다.
                    </span>
                    <span className="hidden group-has-[input[value=partial]:checked]:inline">
                      부분 환불도 수강 포기입니다 — 반영되면 신청이 종료되고 이용권·디스코드 역할이 회수되며 좌석이 반환됩니다. 남은 금액은 추가로 환불할 수 있습니다.
                    </span>
                  </p>
                  <fieldset className="flex flex-col gap-2 text-sm">
                    <legend className="font-medium">환불 범위</legend>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="mode"
                        value="full"
                        defaultChecked={
                          amountDefault && amountDefault.mode !== "none"
                            ? amountDefault.mode === "full"
                            : true
                        }
                        className={radioClass}
                      />
                      전액 ({refundableAmount.toLocaleString()}원)
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="mode"
                        value="partial"
                        defaultChecked={
                          amountDefault
                            ? amountDefault.mode === "partial"
                            : false
                        }
                        className={radioClass}
                      />
                      부분
                    </label>
                    {/* required 없음: 숨겨진 필수 입력은 "전액" 제출을 브라우저가 막는다. 부분인데 금액이
                        없으면 서버(requestOrderRefund)가 안내 메시지로 거부한다. */}
                    <Input
                      name="partialAmount"
                      type="number"
                      min={1}
                      max={refundableAmount}
                      defaultValue={
                        amountDefault?.mode === "partial"
                          ? amountDefault.amount ?? undefined
                          : (proposal?.suggestedPartialAmount ?? undefined)
                      }
                      placeholder="금액(원)"
                      className="hidden group-has-[input[value=partial]:checked]:block"
                    />
                    {requestSnapshot && typeof requestSnapshot.amount === "number" && (
                      <p className="hidden text-xs text-amber-700 group-has-[input[value=partial]:checked]:block">
                        신청 시점 제안액은 {requestSnapshot.amount.toLocaleString()}원입니다. 제안과 다른 금액을 입력하면 사유에 이유를 적어 주세요.
                      </p>
                    )}
                    {!requestSnapshot && proposal?.suggestedPartialAmount != null && (
                      <p className="hidden text-xs text-gray-500 group-has-[input[value=partial]:checked]:block">
                        금액 칸에 약관 기준 제안({proposal.suggestedPartialAmount.toLocaleString()}원)을 미리 넣어 두었습니다. 필요하면 고쳐 쓰세요. 제안일 뿐입니다.
                      </p>
                    )}
                    <label className="hidden items-center gap-2 text-xs text-gray-700 group-has-[input[value=partial]:checked]:flex">
                      <input type="checkbox" name="keepOrder" value="true" className="rounded" />
                      <span>수강 권한 유지 (회차 취소 보상 환불) — 체크 시 수강권 및 디스코드 역할을 유지합니다.</span>
                    </label>
                  </fieldset>
                </div>

                <label className="flex flex-col gap-1 text-sm">
                  사유(필수)
                  <Textarea
                    name="reason"
                    required
                    rows={2}
                    placeholder="환불 사유"
                  />
                </label>
                <ActionFormSubmitButton variant="destructive" className="self-start">
                  환불 요청 확정
                </ActionFormSubmitButton>
              </ActionForm>
            </Modal>

            <Modal triggerLabel="PG 외 환불 반영" title="PG 외 환불을 원장에 반영할까요?">
              <ActionForm action={manual.action} closeModalOnDone className="flex flex-col gap-3">
                <input type="hidden" name="formKey" value={formKey} />
                <p className="text-sm text-gray-600">
                  PG가 영구 거절했거나 콘솔 밖(계좌이체)으로 돈을 돌려준 뒤에만 사용합니다.
                  환불이 반영되면 신청이 종료되고(수강 유지 옵션 미선택 시) 같은 강의에 다시 신청할 수 없습니다.
                </p>
                <label className="flex flex-col gap-1 text-sm">
                  금액(원)
                  <Input
                    name="amount"
                    type="number"
                    min={1}
                    max={refundableAmount}
                    required
                    defaultValue={refundableAmount}
                  />
                </label>
                <label className="flex items-center gap-2 text-xs text-gray-700">
                  <input type="checkbox" name="keepOrder" value="true" className="rounded" />
                  <span>수강 권한 유지 (회차 취소 보상 환불) — 체크 시 수강권 및 디스코드 역할을 유지합니다.</span>
                </label>
                <RefundMethodSelect originalPaymentMethod={originalPaymentMethod} />
                <label className="flex flex-col gap-1 text-sm">
                  사유(필수)
                  <Textarea
                    name="reason"
                    required
                    rows={2}
                    placeholder="예: PG 기간 만료 후 계좌이체"
                  />
                </label>
                <ActionFormSubmitButton variant="default" className="self-start">
                  원장 반영
                </ActionFormSubmitButton>
              </ActionForm>
            </Modal>
          </div>
        </>
      )}
      {resultDialog}
    </div>
  );
}
