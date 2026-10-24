"use client";

import { useState } from "react";
import Link from "next/link";
import type { ActionResult } from "@/lib/errors";
import type {
  OfferingDetailView,
  BulkRefundMode,
  BulkRefundPreviewResult,
  BulkRefundExecutePayload,
  BulkRefundExecuteResult,
} from "@/ui/views/admin/course-offering-detail";
import { Modal } from "@/ui/forms/Modal";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { ResultDialog } from "@/ui/forms/ResultDialog";
import { useResultAction } from "@/ui/forms/useResultAction";
import { Button } from "@/ui/shadcn/button";
import { Input } from "@/ui/shadcn/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/shadcn/table";
import { BulkRefundModal } from "./BulkRefundModal";

type Processing = NonNullable<Extract<OfferingDetailView, { kind: "ok" }>["orders"]["processing"]>;

export type BulkAction = (prev: ActionResult<string> | null, fd: FormData) => Promise<ActionResult<string>>;

// 수강생 처리 및 선별·일괄 환불.
// 어느 강의 상태에서든 수강생을 선택하여 약관 제안·전액·같은 금액 기준의 미리보기 표를 확인하고 행별 결정액을 수정하여 일괄 환불(PG)할 수 있다.
// 폐강 진행 중인 경우, 모든 수강생이 환불 또는 환불 없이 종료되어야 폐강 마무리가 가능하다.
export function OfferingStudentProcessing({
  processing,
  previewBulkRefundAction,
  executeBulkRefundAction,
  closeAction,
}: {
  processing: Processing;
  previewBulkRefundAction: (
    orderIds: string[],
    mode: BulkRefundMode,
    options?: { fixedAmount?: number },
  ) => Promise<ActionResult<BulkRefundPreviewResult>>;
  executeBulkRefundAction: (
    payload: BulkRefundExecutePayload,
  ) => Promise<ActionResult<BulkRefundExecuteResult>>;
  closeAction: BulkAction;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkResultMsg, setBulkResultMsg] = useState<string | null>(null);
  const close = useResultAction(closeAction);
  const done = close.result;

  const rows = processing.rows;
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const selectedOrderIds = selectedRows.map((r) => r.id);
  const hiddenIds = selectedRows.map((r) => <input key={r.id} type="hidden" name="orderId" value={r.id} />);

  return (
    <section className="mt-8" data-testid="student-processing">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">
            {processing.isCancelling ? "수강생 처리 (폐강)" : "수강생 환불 및 수강 처리"}
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            수강생을 선택하여 약관 제안·전액·부분 금액을 확인하고 일괄 환불(PG)하거나, 환불 없이 수강을 종료할 수 있습니다.
            부분 환불도 PG 처리 후 신청이 종료되며(수강 포기/운영 사정 환불), PG 외 환불은 「상세」에서 개별로 처리하세요.
          </p>
        </div>
      </div>

      {processing.blockers.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-sm text-orange-800">
          {processing.blockers.map((b) => (
            <li key={b.orderId}>
              <Link href={`/admin/orders/${b.orderId}`} className="underline">
                {b.orderId.slice(0, 8)}
              </Link>{" "}
              — {b.reason}
            </li>
          ))}
        </ul>
      )}

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-green-700">
          처리할 수강생이 없습니다.
          {processing.isCancelling && processing.blockers.length === 0 && " 폐강 마무리를 누를 수 있습니다."}
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-sm text-gray-600">선택 {selectedRows.length}명</span>
            {selectedRows.length === 0 ? (
              <>
                <Button size="sm" disabled>선별·일괄 환불(PG)</Button>
                {processing.isCancelling && (
                  <Button size="sm" variant="destructive" disabled>선택한 학생 환불 없이 종료</Button>
                )}
              </>
            ) : (
              <>
                <BulkRefundModal
                  selectedOrderIds={selectedOrderIds}
                  previewAction={previewBulkRefundAction}
                  executeAction={executeBulkRefundAction}
                  onComplete={(msg) => {
                    setSelected(new Set());
                    setBulkResultMsg(msg);
                  }}
                />

                {processing.isCancelling && (
                  <Modal triggerLabel="선택한 학생 환불 없이 종료" title="선택한 학생의 수강을 환불 없이 종료할까요?">
                    <ActionForm action={close.action} closeModalOnDone className="flex flex-col gap-3">
                      {hiddenIds}
                      <p className="rounded-sm bg-orange-50 px-3 py-2 text-sm font-medium text-orange-900">
                        선택한 {selectedRows.length}명의 수강을 종료하고 이용권·디스코드 역할을 회수합니다. 결제 금액은 돌려주지 않고 그대로 둡니다.
                        되돌릴 수 없고, 이 학생은 같은 강의에 다시 신청할 수 없습니다. 환불이 필요하면 먼저 환불하세요.
                      </p>
                      {selectedRows.some((r) => r.hasOpenStudentRequest) && (
                        <p className="rounded-sm bg-red-50 px-3 py-2 text-xs font-semibold text-red-800" data-testid="close-refund-request-warning">
                          ⚠️ 선택한 학생 중 환불을 신청한 학생이 포함되어 있습니다. 환불 없이 종료하면 환불 신청 건도 함께 닫힙니다.
                        </p>
                      )}
                      <label className="flex flex-col gap-1 text-sm">
                        종료 사유(필수)
                        <Input name="reason" required placeholder="예: 강의 폐강 — 개별 정산 완료" />
                      </label>
                      <ActionFormSubmitButton variant="destructive" className="self-start">환불 없이 종료</ActionFormSubmitButton>
                      <ActionFormError className="text-xs text-red-600" />
                    </ActionForm>
                  </Modal>
                )}
              </>
            )}
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <input
                    type="checkbox"
                    aria-label="전체 선택"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
                  />
                </TableHead>
                <TableHead>수강생</TableHead>
                <TableHead>수강상태</TableHead>
                <TableHead>결제상태</TableHead>
                <TableHead>금액</TableHead>
                <TableHead>환불 가능</TableHead>
                <TableHead>환불 자격</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} data-testid={`processing-row-${row.id}`}>
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={`${row.email} 선택`}
                      checked={selected.has(row.id)}
                      onChange={() => toggle(row.id)}
                    />
                  </TableCell>
                  <TableCell>
                    {row.email}
                    {row.name ? ` (${row.name})` : ""}
                  </TableCell>
                  <TableCell>{row.statusText}</TableCell>
                  <TableCell>
                    {row.paymentText}
                    {row.openRefund && <span className="ml-1 text-xs text-orange-700">(환불 요청 진행 중)</span>}
                    {row.studentRefundRequestText && (
                      <div className="mt-0.5 text-xs font-medium text-red-600" data-testid="student-refund-request">
                        {row.studentRefundRequestText}
                        {row.studentRefundProposalText && (
                          <div className="text-[11px] text-red-800 font-normal">
                            {row.studentRefundProposalText}
                          </div>
                        )}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{row.amountText}</TableCell>
                  <TableCell>{row.refundableText}</TableCell>
                  <TableCell>
                    {row.canPgRefund ? (
                      <span className="text-xs text-green-700 font-medium">PG 환불 가능</span>
                    ) : (
                      <span className="text-xs text-gray-500">
                        {row.pgExclusionReason ?? "제외"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Link href={row.href} className="text-blue-600 underline text-xs">
                      상세
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}

      {bulkResultMsg && (
        <ResultDialog
          ok={true}
          message={bulkResultMsg}
          onClose={() => setBulkResultMsg(null)}
        />
      )}

      {done && (
        <ResultDialog
          ok={done.ok}
          message={done.ok ? (typeof done.data === "string" ? done.data : "처리되었습니다.") : done.message}
          onClose={() => {
            close.clear();
            setSelected(new Set());
          }}
        />
      )}
    </section>
  );
}
