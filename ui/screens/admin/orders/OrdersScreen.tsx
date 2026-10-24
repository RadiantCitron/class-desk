"use client";

import Link from "next/link";
import type { ActionResult } from "@/lib/errors";
import type { AdminOrdersView } from "@/ui/views/admin/orders";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { Badge } from "@/ui/shadcn/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/shadcn/table";

type OrderAction = (orderId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;

import { useState } from "react";
import { Modal } from "@/ui/forms/Modal";
import { Input } from "@/ui/shadcn/input";

export function OrdersScreen({
  view,
  approveAction,
  rejectAction,
  cancelAction,
}: {
  view: AdminOrdersView;
  approveAction: OrderAction;
  rejectAction: OrderAction;
  cancelAction: OrderAction;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl p-8">
      <h1 className="text-xl font-bold">수강 신청 내역</h1>
      <p className="mt-2 text-sm text-gray-500">
        신청은 자동으로 접수됩니다. 개설강의에 자동승인이 켜져 있으면 바로 승인되고, 꺼져 있으면
        관리자·매니저가 여기서 수동으로 승인해야 등록(수강 확정)됩니다.
      </p>

      {view.refundRequests.length > 0 && (
        <section className="mt-6 rounded-sm border border-blue-200 bg-blue-50 p-3 text-sm" data-testid="refund-requests">
          <h2 className="font-medium text-blue-900">환불 신청 {view.refundRequests.length}건 — 검토가 필요합니다</h2>
          <p className="mt-1 text-xs text-blue-800">
            수강생이 신청만 한 상태입니다. 주문 상세에서 약관 기준 제안을 보고 환불하거나 사유를 적어 거절하세요. 경과일은 참고용입니다(3일 이상 주의, 5일 이상 경고).
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {view.refundRequests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2" data-testid={`refund-request-${r.id}`}>
                <Link href={r.href} className="font-mono text-xs underline">
                  {r.shortId}
                </Link>
                <span>{r.courseText}</span>
                <span className="text-gray-600">{r.email}</span>
                <span className={r.level === "ALERT" ? "font-medium text-red-700" : r.level === "WARN" ? "font-medium text-amber-700" : "text-gray-600"}>{r.text}</span>
                {r.isNotAllowedSection && (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-800" data-testid="refund-not-allowed-badge">
                    약관상 불가 구간 신청
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Table className="mt-6 w-full text-sm">
        <TableHeader>
          <TableRow className="border-b text-left text-gray-500">
            <TableHead className="py-2">ID</TableHead>
            <TableHead>강의</TableHead>
            <TableHead>이메일</TableHead>
            <TableHead>디스코드 ID</TableHead>
            <TableHead>수강상태</TableHead>
            <TableHead>결제상태</TableHead>
            {view.canApprove && <TableHead></TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.rows.map((order) => (
            <TableRow key={order.id} className="border-b">
              <TableCell className="py-2 font-mono text-xs text-gray-400">
                <Link href={order.href} className="underline">
                  {order.shortId}
                </Link>
              </TableCell>
              <TableCell className="py-2">{order.courseText}</TableCell>
              <TableCell>{order.email}</TableCell>
              <TableCell className="font-mono text-gray-400">{order.discordId}</TableCell>
              <TableCell>
                <Badge variant="outline">{order.statusCode}</Badge>
                {order.endLabel && (
                  <span className="ml-1 text-xs text-gray-600" data-testid="end-label">
                    {order.endLabel}
                  </span>
                )}
                {order.refundRequest && (
                  <>
                    <span
                      className={`ml-1 text-xs ${order.refundRequest.level === "ALERT" ? "font-medium text-red-700" : order.refundRequest.level === "WARN" ? "font-medium text-amber-700" : "text-blue-700"}`}
                      data-testid="refund-request-badge"
                    >
                      {order.refundRequest.text}
                    </span>
                    {order.refundRequest.isNotAllowedSection && (
                      <span className="ml-1 rounded bg-red-100 px-1 py-0.5 text-[10px] font-semibold text-red-800" data-testid="refund-not-allowed-badge">
                        약관상 불가 구간
                      </span>
                    )}
                  </>
                )}
              </TableCell>
              <TableCell>
                <Badge variant="outline">{order.paymentStatusCode}</Badge>
                {order.refundedText && (
                  <span className="ml-1 text-xs text-gray-400">{order.refundedText}</span>
                )}
              </TableCell>
              {view.canApprove && (
                <TableCell className="flex flex-col items-start gap-1 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {order.canDecide && (
                      <>
                        <ActionForm action={approveAction.bind(null, order.id)}>
                          <ActionFormSubmitButton className="text-green-700 underline disabled:text-gray-400">
                            승인
                          </ActionFormSubmitButton>
                          <ActionFormError className="text-xs text-red-600" />
                        </ActionForm>
                        <Modal triggerLabel="반려" title="수강 신청 반려">
                          <p className="text-xs text-gray-500 mb-2">반려 사유를 입력하세요. 사유는 기록에 남습니다.</p>
                          <ActionForm action={rejectAction.bind(null, order.id)} closeModalOnDone className="flex flex-col gap-2">
                            <Input name="reason" type="text" required placeholder="반려 사유 입력" />
                            <ActionFormSubmitButton variant="destructive">반려 확정</ActionFormSubmitButton>
                            <ActionFormError className="text-xs text-red-600" />
                          </ActionForm>
                        </Modal>
                      </>
                    )}
                    {order.canCancel && (
                      <Modal triggerLabel="취소" title="승인된 신청 취소">
                        <p className="text-xs text-gray-500 mb-2">취소 사유를 입력하세요. 결제 전 신청이 취소됩니다.</p>
                        <ActionForm action={cancelAction.bind(null, order.id)} closeModalOnDone className="flex flex-col gap-2">
                          <Input name="reason" type="text" required placeholder="취소 사유 입력" />
                          <ActionFormSubmitButton variant="destructive">취소 확정</ActionFormSubmitButton>
                          <ActionFormError className="text-xs text-red-600" />
                        </ActionForm>
                      </Modal>
                    )}
                  </div>
                  {order.canDecide && order.isStarted && (
                    <span className="text-[11px] text-amber-700" data-testid="started-approval-warning">
                      ⚠️ 개강 뒤 승인 — 학생은 결제할 수 없습니다
                    </span>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </main>
  );
}
