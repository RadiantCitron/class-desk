import Link from "next/link";
import type { OrderDetailView, TimelineKind } from "@/ui/views/admin/order-detail";
import type { ActionResult } from "@/lib/errors";
import { FlowHeader } from "@/ui/shell/FlowHeader";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { Alert, AlertDescription } from "@/ui/shadcn/alert";
import { Input } from "@/ui/shadcn/input";
import { Separator } from "@/ui/shadcn/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/shadcn/table";
import { RefundPanel, type OrderAction } from "@/ui/screens/admin/orders/RefundPanel";
import { RefundRequestPanel } from "@/ui/screens/admin/orders/RefundRequestPanel";

const KIND_STYLE: Record<TimelineKind, string> = {
  ORDER: "bg-blue-100 text-blue-700",
  PAYMENT: "bg-green-100 text-green-700",
  OUTBOX: "bg-indigo-100 text-indigo-700",
  DLQ: "bg-red-100 text-red-700",
  ENTITLEMENT: "bg-teal-100 text-teal-700",
  AUDIT: "bg-purple-100 text-purple-700",
};

export function OrderDetailScreen({
  view,
  confirmPaymentAction,
  grantAccessAction,
  closeWithoutRefundAction,
  refundAction,
  markFailedAction,
  manualRefundAction,
  rejectRefundRequestAction,
  decideNoRefundAction,
}: {
  view: OrderDetailView;
  confirmPaymentAction: (orderId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  grantAccessAction: (orderId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  closeWithoutRefundAction: OrderAction;
  refundAction: OrderAction;
  markFailedAction: OrderAction;
  manualRefundAction: OrderAction;
  rejectRefundRequestAction: OrderAction;
  decideNoRefundAction?: OrderAction;
}) {
  if (view.kind === "notFound") {
    return (
      <main className="mx-auto w-full max-w-3xl p-8">
        <h1 className="text-xl font-bold">주문을 찾을 수 없습니다</h1>
      </main>
    );
  }

  const { isAdmin, orderId } = view;

  return (
    <main className="mx-auto w-full max-w-3xl p-8">
      <FlowHeader backHref="/admin/orders" backLabel="← 수강 신청 내역" />
      <h1 className="mt-2 text-xl font-bold">{view.itemLabel}</h1>
      <p className="text-xs text-gray-400">주문 ID: {orderId}</p>

      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <dt className="text-gray-500">신청자</dt>
        <dd>{view.buyerEmail}</dd>
        <dt className="text-gray-500">수강상태</dt>
        <dd>
          {view.statusCode}
          {view.endLabel && (
            <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700" data-testid="end-label">
              {view.endLabel}
            </span>
          )}
        </dd>
        <dt className="text-gray-500">결제상태</dt>
        <dd>
          {view.paymentStatusCode}
          {view.paymentStatusBadge && (
            <span className="ml-2 rounded bg-teal-100 px-1.5 py-0.5 text-xs text-teal-800">
              {view.paymentStatusBadge}
            </span>
          )}
          {view.refundedText && <span className="ml-1 text-xs text-gray-400">{view.refundedText}</span>}
        </dd>
        <dt className="text-gray-500">결제 금액</dt>
        <dd>{view.amountText}</dd>
        <dt className="text-gray-500">신청일</dt>
        <dd>{view.createdText}</dd>
      </dl>

      {view.unreflectedSuccess && (
        <Alert className="mt-4 border-amber-200 bg-amber-50 text-amber-800">
          <AlertDescription>
            <p>
              결제 이력에 &quot;결제 성공&quot;이 남아 있지만, 아직 이 주문에는 반영되지
              않았습니다(CS-C — 결제 정보 확인이 필요한 상태). 아래 아웃박스·DLQ 항목을 확인하세요.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {!isAdmin && (
        <Alert className="mt-4 border-gray-200 bg-gray-50 text-gray-500">
          <AlertDescription>
            <p className="text-xs">
              결제 가능 여부 사유(CS-A)와 거래 기록(주문·결제 이력, 아웃박스, DLQ, 이용권)은 ADMIN에게만 보입니다.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {view.eligibilityFailures && (
        <Alert className="mt-4 border-amber-200 bg-amber-50 text-amber-800">
          <AlertDescription>
            <p className="font-medium">CS-A — 학생이 결제할 수 없는 이유(자격검증 실패 사유):</p>
            <ul className="mt-2 list-disc pl-5">
              {view.eligibilityFailures.map((rule) => (
                <li key={rule.code}>
                  {rule.code}: {rule.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {view.canConfirmManually && (
        <div className="mt-6 rounded border p-4">
          <p className="text-sm font-medium">관리자 수동 결제 확정</p>
          <p className="mt-1 text-xs text-gray-500">
            계좌이체 등으로 결제를 실제로 받았을 때만 사용합니다. 사유는 감사 기록에 남습니다.
          </p>
          {view.discordWarning && (
            <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-800 border border-amber-200">
              ⚠️ {view.discordWarning}
            </p>
          )}
          <ActionForm action={confirmPaymentAction.bind(null, orderId)} className="mt-2 flex items-center gap-2">
            <Input name="reason" type="text" required placeholder="확정 사유(예: 계좌이체 확인, 2026-09-26)" />
            <ActionFormSubmitButton variant="default" className="shrink-0">
              수동 확정
            </ActionFormSubmitButton>
            <ActionFormError className="mt-1 text-xs text-red-600" />
          </ActionForm>
        </div>
      )}

      {view.canGrantAccess && (
        <div className="mt-6 rounded border p-4">
          <p className="text-sm font-medium">직권 수강 부여 (결제 없이)</p>
          <p className="mt-1 text-xs text-gray-500">
            결제 없이 수강권을 부여합니다(초대·무료 수강 등). 돈을 받았다면 위 「수동 결제 확정」을 쓰세요. 결제 기록은 남기지 않으며,
            부여를 되돌리는 버튼은 아직 없습니다(폐강·강의 종료 기능으로 정리). 사유는 주문 기록과 감사 기록에 남습니다.
          </p>
          {view.discordWarning && (
            <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-800 border border-amber-200">
              ⚠️ {view.discordWarning}
            </p>
          )}
          <ActionForm action={grantAccessAction.bind(null, orderId)} className="mt-2 flex items-center gap-2">
            <Input name="reason" type="text" required placeholder="부여 사유(예: 초대 수강생, 2026-10-08)" />
            <ActionFormSubmitButton variant="default" className="shrink-0">
              직권 부여
            </ActionFormSubmitButton>
            <ActionFormError className="mt-1 text-xs text-red-600" />
          </ActionForm>
        </div>
      )}

      {view.canCloseWithoutRefund && (
        <div className="mt-6 rounded border p-4" data-testid="close-without-refund">
          <p className="text-sm font-medium">수강 종료 (환불 없이) — 폐강 처리</p>
          <p className="mt-1 text-xs text-gray-500">
            폐강된 강의의 이 수강생을 환불 없이 종료합니다. 결제 금액은 그대로 두고 수강만 끝나며 이용권·디스코드 역할이 회수됩니다. 되돌릴 수
            없고 같은 강의에 다시 신청할 수 없습니다. 환불이 필요하면 아래 환불을 먼저 하세요(부분 환불이 반영되면 신청이 이미 종료됩니다).
            사유는 주문 기록과 감사 기록에 남습니다.
          </p>
          <ActionForm action={closeWithoutRefundAction.bind(null, orderId)} className="mt-2 flex items-center gap-2">
            <Input name="reason" type="text" required placeholder="종료 사유(예: 폐강 — 부분 환불 후 정산 완료)" />
            <ActionFormSubmitButton variant="destructive" className="shrink-0">
              환불 없이 종료
            </ActionFormSubmitButton>
            <ActionFormError className="mt-1 text-xs text-red-600" />
          </ActionForm>
        </div>
      )}

      {view.canDecideNoRefund && decideNoRefundAction && (
        <div className="mt-6 rounded border border-amber-200 bg-amber-50/30 p-4" data-testid="decide-no-refund">
          <p className="text-sm font-medium text-amber-900">환불하지 않고 마무리</p>
          <p className="mt-1 text-xs text-amber-800">
            탈퇴 등으로 이미 취소된 주문에 남은 결제 잔액을 환불하지 않고 종결 처리합니다(대사의 미환불 경고 해소). 사유는 주문 기록과 감사 기록에 남습니다.
          </p>
          <ActionForm action={decideNoRefundAction.bind(null, orderId)} className="mt-2 flex items-center gap-2">
            <Input name="reason" type="text" required placeholder="마무리 결정 사유(예: 회원 탈퇴 후 환불 미요청 합의 종결)" />
            <ActionFormSubmitButton variant="default" className="shrink-0">
              마무리 결정
            </ActionFormSubmitButton>
            <ActionFormError className="mt-1 text-xs text-red-600" />
          </ActionForm>
        </div>
      )}

      {view.refundRequest && (
        <RefundRequestPanel orderId={orderId} request={view.refundRequest} rejectAction={rejectRefundRequestAction} />
      )}

      {view.refund && (
        <RefundPanel
          originalPaymentMethod={view.refund.originalPaymentMethod}
          proposal={view.refund.proposal}
          requestSnapshot={view.refund.requestSnapshot}
          amountDefault={view.refund.amountDefault}
          orderId={orderId}
          refundableAmount={view.refund.refundableAmount}
          requestKey={view.refund.requestKey}

          formKey={view.refund.formKey}
          openRequest={view.refund.openRequest}
          isOrphanPayment={view.refund.isOrphanPayment}
          orphanKind={view.refund.orphanKind}
          digitalConsumed={view.refund.digitalConsumed}
          refundAction={refundAction}
          markFailedAction={markFailedAction}
          manualRefundAction={manualRefundAction}
        />
      )}

      <Separator className="mt-8" />
      <h2 className="mt-8 text-lg font-bold">거래 기록</h2>
      <p className="mt-1 text-xs text-gray-400">
        DLQ 목록은 주문 ID로 특정할 수 있는 실패만 보입니다(서명 검증 실패 등 주문을 알기 전
        실패는 여기 안 보일 수 있습니다 — 전체 DLQ는{" "}
        <Link href="/admin/dlq" className="underline">
          /admin/dlq
        </Link>
        ).
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {view.timeline.map((item) => (
          <li key={item.id} className="flex items-start gap-3 rounded border p-3 text-sm">
            <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${KIND_STYLE[item.kind]}`}>{item.kindLabel}</span>
            <div>
              <p className="font-medium">{item.label}</p>
              <p className="text-xs text-gray-500">{item.detail}</p>
              <p className="text-xs text-gray-400">{item.timeText}</p>
            </div>
          </li>
        ))}
      </ul>
      {view.timeline.length === 0 && (
        <p className="text-sm text-gray-400">{isAdmin ? "기록이 없습니다." : "거래 기록은 ADMIN에게만 보입니다."}</p>
      )}

      <details className="mt-8 rounded border p-3">
        <summary className="cursor-pointer text-sm font-bold">결제 요청 이력 (PG 호출 — 결제 장애 확인용)</summary>
        <p className="mt-2 text-xs text-gray-500">
          우리가 PG에 결제를 요청한 기록입니다. 돈이 실제로 움직였는지는 위 거래 기록의 결제 이력(원장)이
          정본이고, PG 쪽 정본은 PG 관리화면(토스 상점관리자)입니다.
        </p>
        {!isAdmin || view.attempts === null ? (
          <p className="mt-2 text-xs text-gray-400">결제 요청 이력은 ADMIN에게만 보입니다.</p>
        ) : view.attempts.length === 0 ? (
          <p className="mt-2 text-sm text-gray-400">결제 요청 기록이 없습니다.</p>
        ) : (
          <Table className="mt-2 w-full text-xs">
            <TableHeader>
              <TableRow className="border-b text-left text-gray-500">
                <TableHead className="py-1">결제 요청 시각</TableHead>
                <TableHead>PG 주문번호</TableHead>
                <TableHead>PG</TableHead>
                <TableHead>승인 요청</TableHead>
                <TableHead>결제 이력 결과</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.attempts.map((a) => (
                <TableRow key={a.id} className="border-b align-top">
                  <TableCell className="py-1">{a.timeText}</TableCell>
                  <TableCell>
                    <span className="font-mono">{a.pgOrderId}</span>
                  </TableCell>
                  <TableCell>{a.provider}</TableCell>
                  <TableCell>{a.confirmText}</TableCell>
                  <TableCell>{a.resultText}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </details>
    </main>
  );
}
