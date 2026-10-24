"use client";

import { useState } from "react";
import type { ActionResult } from "@/lib/errors";
import type {
  BulkRefundMode,
  BulkRefundPreviewResult,
  BulkRefundPreviewRow,
  BulkRefundExecutePayload,
  BulkRefundExecuteResult,
} from "@/ui/views/admin/course-offering-detail";
import { Modal } from "@/ui/forms/Modal";
import { Button } from "@/ui/shadcn/button";
import { Input } from "@/ui/shadcn/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/shadcn/table";

export function BulkRefundModal({
  selectedOrderIds,
  previewAction,
  executeAction,
  onComplete,
}: {
  selectedOrderIds: string[];
  previewAction: (
    orderIds: string[],
    mode: BulkRefundMode,
    options?: { fixedAmount?: number },
  ) => Promise<ActionResult<BulkRefundPreviewResult>>;
  executeAction: (payload: BulkRefundExecutePayload) => Promise<ActionResult<BulkRefundExecuteResult>>;
  onComplete: (resultMessage: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<BulkRefundMode>("policy");
  const [fixedAmountInput, setFixedAmountInput] = useState("");
  const [refundCause, setRefundCause] = useState<"STUDENT" | "OPERATOR">("STUDENT");
  const [commonReason, setCommonReason] = useState("");

  const [preview, setPreview] = useState<BulkRefundPreviewResult | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // 행별 결정액 및 수정 사유 상태: orderId -> { amount: number, reason: string }
  const [decidedMap, setDecidedMap] = useState<
    Record<string, { amount: number; reason: string }>
  >({});

  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);

  const resetState = () => {
    setPreview(null);
    setPreviewError(null);
    setExecuteError(null);
    setDecidedMap({});
    setCommonReason("");
  };

  const handleOpen = () => {
    resetState();
    setOpen(true);
  };

  const handleClose = () => {
    if (executing) return;
    setOpen(false);
  };

  // 1. 미리보기 호출
  const handleLoadPreview = async (selectedMode: BulkRefundMode) => {
    setLoadingPreview(true);
    setPreviewError(null);
    setExecuteError(null);

    let fixedAmount: number | undefined = undefined;
    if (selectedMode === "fixed") {
      const parsed = Number(fixedAmountInput.replace(/,/g, "").trim());
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setPreviewError("같은 금액 모드에서는 올바른 양의 정수(원)를 입력해 주세요.");
        setLoadingPreview(false);
        return;
      }
      fixedAmount = parsed;
    }

    try {
      const res = await previewAction(selectedOrderIds, selectedMode, { fixedAmount });
      if (!res.ok) {
        setPreviewError(res.message);
        setPreview(null);
      } else {
        const previewData = res.data;
        if (!previewData.ok) {
          setPreviewError(previewData.error);
          setPreview(null);
        } else {
          setPreview(previewData);
          // 기본 결정액 초기화
          const nextMap: Record<string, { amount: number; reason: string }> = {};
          for (const row of previewData.rows) {
            nextMap[row.orderId] = {
              amount: row.defaultDecidedAmount,
              reason: "",
            };
          }
          setDecidedMap(nextMap);
        }
      }
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingPreview(false);
    }
  };

  // 행별 결정액 변경 핸들러
  const handleRowAmountChange = (orderId: string, val: string) => {
    const parsed = Number(val.replace(/,/g, "").trim()) || 0;
    setDecidedMap((prev) => ({
      ...prev,
      [orderId]: {
        amount: parsed,
        reason: prev[orderId]?.reason ?? "",
      },
    }));
  };

  // 행별 수정 사유 변경 핸들러
  const handleRowReasonChange = (orderId: string, val: string) => {
    setDecidedMap((prev) => ({
      ...prev,
      [orderId]: {
        amount: prev[orderId]?.amount ?? 0,
        reason: val,
      },
    }));
  };

  // 2. 검증 및 요약 계산
  const previewRows = preview?.ok ? preview.rows : [];
  const eligibleRows = previewRows.filter((r) => r.eligible);

  let currentTotalDecided = 0;
  let partialCount = 0;
  let fullCount = 0;
  let validationError: string | null = null;

  if (preview?.ok) {
    if (!commonReason.trim()) {
      validationError = "공통 환불 사유를 입력해 주세요.";
    }

    for (const r of eligibleRows) {
      const d = decidedMap[r.orderId] ?? { amount: 0, reason: "" };
      currentTotalDecided += d.amount;
      if (d.amount === r.refundableAmount) {
        fullCount++;
      } else if (d.amount < r.refundableAmount) {
        partialCount++;
      }

      if (d.amount <= 0) {
        validationError = `${r.email}: 결정액은 0원보다 커야 합니다.`;
      } else if (d.amount > r.refundableAmount) {
        validationError = `${r.email}: 결정액이 환불 가능액(${r.refundableAmount.toLocaleString()}원)을 초과합니다.`;
      } else if (d.amount !== r.proposalAmount && !d.reason.trim() && !commonReason.trim()) {
        validationError = `${r.email}: 약관 제안액(${r.proposalAmount.toLocaleString()}원)과 결정액이 다른 경우 수정 사유(또는 공통 사유)가 필수입니다.`;
      }
    }

    if (eligibleRows.length === 0) {
      validationError = "환불 가능한 대상이 없습니다.";
    }
  }

  // 3. 확정 실행
  const handleExecute = async () => {
    if (!preview || !preview.ok || validationError || executing) return;

    setExecuting(true);
    setExecuteError(null);

    const payload: BulkRefundExecutePayload = {
      batchId: preview.batchId,
      refundCause,
      commonReason: commonReason.trim(),
      rows: eligibleRows.map((r) => {
        const d = decidedMap[r.orderId]!;
        return {
          orderId: r.orderId,
          decidedAmount: d.amount,
          rowReason: d.reason.trim() || commonReason.trim(),
          seenRefundable: r.refundableAmount,
          seenProposalAmount: r.proposalAmount,
        };
      }),
    };

    try {
      const res = await executeAction(payload);
      if (!res.ok) {
        setExecuteError(res.message);
      } else {
        const data = res.data;
        setOpen(false);
        onComplete(data.summaryMessage);
      }
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
    }
  };

  return (
    <Modal
      triggerLabel="선별·일괄 환불(PG)"
      title={`선별·일괄 환불 (${selectedOrderIds.length}명 선택됨)`}
      contentClassName="max-h-[90vh] w-[95vw] max-w-5xl overflow-y-auto"
      open={open}
      onOpenChange={(next) => (next ? handleOpen() : handleClose())}
    >
      <div className="flex flex-col gap-4 pt-1">
          {/* 환불 분류 선택 */}
          <div className="flex flex-col gap-1.5 rounded-md border bg-gray-50 p-3">
            <span className="text-xs font-semibold text-gray-700">환불 분류 (필수)</span>
            <div className="flex items-center gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="refundCause"
                  value="STUDENT"
                  checked={refundCause === "STUDENT"}
                  onChange={() => setRefundCause("STUDENT")}
                />
                <span>학생 사정 (기본 — 수강 포기로 기록)</span>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="refundCause"
                  value="OPERATOR"
                  checked={refundCause === "OPERATOR"}
                  onChange={() => setRefundCause("OPERATOR")}
                />
                <span>우리 사정 (운영 사정으로 환불 — 수강 포기 아님)</span>
              </label>
            </div>
          </div>

          {/* 모드 선택 및 미리보기 로드 버튼 */}
          <div className="flex flex-wrap items-end gap-3 rounded-md border p-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-700">
              환불 모드 (기본 결정액 설정)
              <select
                className="h-9 rounded-md border px-2 text-sm"
                value={mode}
                onChange={(e) => {
                  const m = e.target.value as BulkRefundMode;
                  setMode(m);
                }}
              >
                <option value="policy">약관 제안액 기준 (규정대로 일괄 처리)</option>
                <option value="full">전액 기준 (환불 가능 잔액 전부)</option>
                <option value="fixed">같은 금액 (모두에게 동일한 금액)</option>
              </select>
            </label>

            {mode === "fixed" && (
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-700">
                1인당 환불 금액(원)
                <Input
                  className="h-9 w-36 text-sm"
                  inputMode="numeric"
                  placeholder="예: 10000"
                  value={fixedAmountInput}
                  onChange={(e) => setFixedAmountInput(e.target.value)}
                />
              </label>
            )}

            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => handleLoadPreview(mode)}
              disabled={loadingPreview || executing}
            >
              {loadingPreview ? "미리보기 조회 중..." : "미리보기 조회"}
            </Button>
          </div>

          {previewError && (
            <p className="rounded bg-red-50 p-2.5 text-xs font-medium text-red-600">
              {previewError}
            </p>
          )}

          {/* 미리보기 표 */}
          {preview?.ok && (
            <div className="flex flex-col gap-3">
              <div className="overflow-x-auto rounded-md border">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow className="bg-gray-50">
                      <TableHead className="w-28">수강생</TableHead>
                      <TableHead className="w-20 text-right">결제액</TableHead>
                      <TableHead className="w-20 text-right">기환불</TableHead>
                      <TableHead className="w-20 text-right">환불 가능액</TableHead>
                      <TableHead className="w-20 text-right">약관 제안액</TableHead>
                      <TableHead className="min-w-44">근거 문장</TableHead>
                      <TableHead className="w-28 text-right">결정액(원)</TableHead>
                      <TableHead className="w-36">수정 사유</TableHead>
                      <TableHead className="w-24">비고</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.rows.map((row) => {
                      const d = decidedMap[row.orderId] ?? { amount: 0, reason: "" };
                      const isDeviated = row.eligible && d.amount !== row.proposalAmount;

                      return (
                        <TableRow
                          key={row.orderId}
                          className={!row.eligible ? "bg-gray-100 text-gray-400" : undefined}
                        >
                          <TableCell className="font-medium">
                            {row.email}
                            {row.name && <span className="block text-gray-500">({row.name})</span>}
                          </TableCell>
                          <TableCell className="text-right">{row.paidAmount.toLocaleString()}원</TableCell>
                          <TableCell className="text-right">{row.refundedAmount.toLocaleString()}원</TableCell>
                          <TableCell className="text-right font-medium">
                            {row.refundableAmount.toLocaleString()}원
                          </TableCell>
                          <TableCell className="text-right">
                            {row.proposalAmount.toLocaleString()}원
                          </TableCell>
                          <TableCell className="text-gray-600 leading-tight">
                            {row.proposalReason}
                          </TableCell>
                          <TableCell className="text-right">
                            {row.eligible ? (
                              <Input
                                className="h-8 w-24 text-right text-xs"
                                inputMode="numeric"
                                value={d.amount}
                                onChange={(e) => handleRowAmountChange(row.orderId, e.target.value)}
                                disabled={executing}
                              />
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell>
                            {row.eligible ? (
                              <Input
                                className={`h-8 text-xs ${isDeviated && !d.reason.trim() ? "border-red-500 bg-red-50" : ""}`}
                                placeholder={isDeviated ? "수정 사유 필수" : "수정 사유(선택)"}
                                value={d.reason}
                                onChange={(e) => handleRowReasonChange(row.orderId, e.target.value)}
                                disabled={executing}
                              />
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell>
                            {!row.eligible ? (
                              <span className="text-red-500">{row.ineligibleReason}</span>
                            ) : isDeviated ? (
                              <span className="text-orange-600 font-semibold">약관제안과 다름</span>
                            ) : (
                              <span className="text-green-600">일치</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* 공통 사유 및 하단 요약 */}
              <div className="flex flex-col gap-2 rounded-md border bg-gray-50 p-3">
                <label className="flex flex-col gap-1 text-xs font-semibold text-gray-700">
                  공통 환불 사유 (필수)
                  <Input
                    placeholder="예: 10월 2회차 폐강에 따른 수강생 일괄 환불"
                    value={commonReason}
                    onChange={(e) => setCommonReason(e.target.value)}
                    disabled={executing}
                  />
                </label>

                <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs text-gray-700">
                  <div className="flex gap-3">
                    <span>
                      대상 수: <b>{eligibleRows.length}명</b> (제외: {preview.rows.length - eligibleRows.length}명)
                    </span>
                    <span>
                      전액: <b>{fullCount}건</b>
                    </span>
                    <span>
                      부분(= 수강 종료·포기): <b>{partialCount}건</b>
                    </span>
                    <span>
                      총 결정 환불액: <b className="text-blue-700">{currentTotalDecided.toLocaleString()}원</b>
                    </span>
                  </div>
                </div>

                <div className="mt-2 border-t pt-2 text-[11px] text-gray-500 space-y-0.5">
                  <p>• 환불은 PG에서 되돌릴 수 없습니다.</p>
                  <p>• 부분 환불은 수강을 종료하고 수강 포기(또는 운영 사정 환불)로 기록합니다.</p>
                  <p>• 확인을 누르면 각 학생별로 독립적인 PG 환불 요청이 실행됩니다.</p>
                </div>
              </div>

              {validationError && (
                <p className="rounded bg-orange-50 p-2 text-xs font-medium text-orange-700">
                  ⚠️ {validationError}
                </p>
              )}

              {executeError && (
                <p className="rounded bg-red-50 p-2 text-xs font-medium text-red-600">
                  ❌ {executeError}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={handleClose} disabled={executing}>
                  취소
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleExecute}
                  disabled={!!validationError || executing}
                >
                  {executing ? "환불 요청 실행 중..." : "위 내용대로 일괄 환불 요청 확정"}
                </Button>
              </div>
            </div>
          )}
        </div>
    </Modal>
  );
}
