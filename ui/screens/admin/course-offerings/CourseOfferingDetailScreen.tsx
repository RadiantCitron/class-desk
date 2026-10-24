import Link from "next/link";
import type { ActionResult } from "@/lib/errors";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { Alert } from "@/ui/shadcn/alert";
import { Input } from "@/ui/shadcn/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/shadcn/table";
import { FlowHeader } from "@/ui/shell/FlowHeader";
import type {
  OfferingDetailView,
  BulkRefundMode,
  BulkRefundPreviewResult,
  BulkRefundExecutePayload,
  BulkRefundExecuteResult,
} from "@/ui/views/admin/course-offering-detail";
import { EditPanel, type EditPanelProps } from "./EditPanel";
import { OfferingCancelControls, type OfferingAction } from "./OfferingCancelControls";
import { OfferingEndControls, type OfferingEndAction } from "./OfferingEndControls";
import { OfferingSessionsSection, type ScheduleChangeAction, type ScheduleExcludeAction, type SessionAddAction, type SessionCancelAction, type SessionCorrectAction } from "./OfferingSessionsSection";
import { OfferingStudentProcessing, type BulkAction } from "./OfferingStudentProcessing";
import { OfferingHistorySection } from "./OfferingHistorySection";
import { OfferingNoticePanel, type OfferingNoticeAction } from "./OfferingNoticePanel";

export type CourseOfferingDetailScreenProps = {
  view: OfferingDetailView;
  updateAction: EditPanelProps["updateAction"];
  toggleAction: (
    offeringId: string,
    nextStatus: "OPEN" | "CLOSED",
    prev: ActionResult | null,
    fd: FormData,
  ) => Promise<ActionResult>;
  deleteAction: (offeringId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  cancelAction: OfferingAction;
  completeCancelAction: OfferingAction;
  revokeCancelAction?: OfferingAction;
  /** 강의 종료(종강일 지난 강의) / 종료 취소. */
  endAction: OfferingEndAction;
  cancelEndAction: OfferingEndAction;
  /** 개설 후 회차 추가·취소. */
  addSessionAction: SessionAddAction;
  cancelSessionAction: SessionCancelAction;
  /** 지난 회차 기록 정정. */
  correctSessionAction?: SessionCorrectAction;
  /** 개설강의 공지문 설정. */
  noticeAction: OfferingNoticeAction;
  /** 수강생이 있는 수업의 일정 변경(안내·동의)과 미동의·무응답 제외 처리. */
  changeScheduleAction: ScheduleChangeAction;
  excludeScheduleChangeAction: ScheduleExcludeAction;
  /** 선별·일괄 환불 미리보기. */
  previewBulkRefundAction: (
    orderIds: string[],
    mode: BulkRefundMode,
    options?: { fixedAmount?: number },
  ) => Promise<ActionResult<BulkRefundPreviewResult>>;
  /** 선별·일괄 환불 실행. */
  executeBulkRefundAction: (
    payload: BulkRefundExecutePayload,
  ) => Promise<ActionResult<BulkRefundExecuteResult>>;
  /** 폐강 중 선택한 학생 일괄 환불 없이 종료. */
  bulkCloseAction: BulkAction;
};

export function CourseOfferingDetailScreen({
  view,
  updateAction,
  toggleAction,
  deleteAction,
  cancelAction,
  completeCancelAction,
  revokeCancelAction,
  endAction,
  cancelEndAction,
  addSessionAction,
  cancelSessionAction,
  correctSessionAction,
  noticeAction,
  changeScheduleAction,
  excludeScheduleChangeAction,
  previewBulkRefundAction,
  executeBulkRefundAction,
  bulkCloseAction,
}: CourseOfferingDetailScreenProps) {
  if (view.kind === "notFound") {
    return (
      <main className="mx-auto w-full max-w-3xl p-8">
        <h1 className="text-xl font-bold">개설강의를 찾을 수 없습니다</h1>
        <p className="mt-4 text-sm">
          <Link href="/admin/course-offerings" className="underline">
            개설강의 목록으로
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl p-8">
      <FlowHeader backHref="/admin/course-offerings" backLabel="← 개설강의 목록" />
      <h1 className="mt-2 text-xl font-bold">{view.title}</h1>

      {view.deleted && (
        <Alert variant="destructive" className="mt-3">
          <p className="font-medium">삭제된 개설강의입니다.</p>
          <p className="mt-1">{view.deleted.text}</p>
          <p className="mt-1 text-xs">기록 보존을 위해 열람만 할 수 있습니다.</p>
        </Alert>
      )}

      <section className="mt-6">
        <h2 className="text-lg font-bold">기본 정보</h2>
        <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-gray-500">과목</dt>
          <dd>{view.basic.course}</dd>
          <dt className="text-gray-500">회차</dt>
          <dd>{view.basic.label}</dd>
          <dt className="text-gray-500">상태</dt>
          <dd>
            {view.basic.statusText}
            {view.basic.statusReasonText && (
              <span className="ml-2 text-xs text-gray-500">{view.basic.statusReasonText}</span>
            )}
          </dd>
          <dt className="text-gray-500">가격</dt>
          <dd>{view.basic.priceText}</dd>
          <dt className="text-gray-500">위치</dt>
          <dd>{view.basic.location}</dd>
          <dt className="text-gray-500">모집 기간</dt>
          <dd>{view.basic.periodText}</dd>
          {view.basic.endText && (
            <>
              <dt className="text-gray-500">종료</dt>
              <dd data-testid="end-record">{view.basic.endText}</dd>
            </>
          )}
          <dt className="text-gray-500">자동승인</dt>
          <dd>{view.basic.autoApproveText}</dd>
          <dt className="text-gray-500">자동환불</dt>
          <dd>{view.basic.autoRefundText}</dd>
          <dt className="text-gray-500">수동 종료</dt>
          <dd>{view.basic.manualEndText}</dd>
          <dt className="text-gray-500">추가 약관</dt>
          <dd>{view.basic.termsText}</dd>
          <dt className="text-gray-500">부여 권한</dt>
          <dd>
            {view.basic.grants.length > 0 ? (
              <ul className="list-disc pl-4">
                {view.basic.grants.map((grant, i) => (
                  <li key={i}>{grant}</li>
                ))}
              </ul>
            ) : (
              "-"
            )}
          </dd>
          <dt className="text-gray-500">생성 / 수정</dt>
          <dd>
            <span className="text-xs text-gray-500">{view.basic.createdText}</span>
          </dd>
        </dl>
        {view.basic.description && (
          <p className="mt-3 whitespace-pre-wrap rounded border p-3 text-xs text-gray-600">
            {view.basic.description}
          </p>
        )}
      </section>

      <OfferingNoticePanel
        offeringId={view.offeringId}
        currentNotice={view.basic.notice}
        noticeAction={noticeAction}
        disabled={!!view.deleted || view.basic.statusText === "폐강완료" || view.basic.statusText === "종료"}
      />

      <OfferingSessionsSection
        offeringId={view.offeringId}
        sessions={view.sessions}
        canEdit={view.sessionEdit.canEdit}
        lockText={view.sessionEdit.lockText}
        progressText={view.sessionProgressText}
        scheduleChange={view.scheduleChange}
        changeAction={changeScheduleAction}
        excludeAction={excludeScheduleChangeAction}
        addAction={addSessionAction}
        cancelAction={cancelSessionAction}
        correctAction={correctSessionAction}
      />

      <section className="mt-8">
        <h2 className="text-lg font-bold">좌석</h2>
        <p className="mt-2 text-sm">{view.seats.text}</p>
        {view.seats.mismatchText && (
          <p className="mt-1 text-sm text-amber-700">{view.seats.mismatchText}</p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-bold">신청·결제 현황</h2>
        <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
          {view.orders.buckets.map((b) => (
            <div key={b.key} className="rounded border p-2">
              <p className="text-xs text-gray-500">{b.label}</p>
              <p className="text-lg font-bold" data-testid={`count-${b.key}`}>
                {b.count}
              </p>
            </div>
          ))}
        </div>
        {view.orders.cancellingText && (
          <p className="mt-2 text-sm text-orange-800">
            {view.orders.cancellingText}{" "}
            <Link href="/admin/dlq" className="underline">
              DLQ
            </Link>
          </p>
        )}
        <p className="mt-3 text-xs text-gray-500">{view.orders.totalText}</p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>수강생</TableHead>
              <TableHead>수강상태</TableHead>
              <TableHead>결제상태</TableHead>
              <TableHead>금액</TableHead>
              <TableHead>신청일</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.orders.rows.map((order) => (
              <TableRow key={order.id}>
                <TableCell>
                  {order.email}
                  {order.name && <span className="ml-1 text-xs text-gray-400">{order.name}</span>}
                </TableCell>
                <TableCell>{order.statusText}</TableCell>
                <TableCell>
                  {order.paymentText}
                  {order.refundedText && (
                    <span className="ml-1 text-xs text-gray-400">{order.refundedText}</span>
                  )}
                </TableCell>
                <TableCell>{order.amountText}</TableCell>
                <TableCell>
                  <span className="text-xs text-gray-400">{order.createdText}</span>
                </TableCell>
                <TableCell>
                  <Link href={order.href} className="text-blue-600 underline">
                    주문 보기
                  </Link>
                </TableCell>
              </TableRow>
            ))}
            {view.orders.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-4 text-sm text-gray-400">
                  아직 신청이 없습니다.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>

      {view.orders.processing && (
        <OfferingStudentProcessing
          processing={view.orders.processing}
          previewBulkRefundAction={previewBulkRefundAction}
          executeBulkRefundAction={executeBulkRefundAction}
          closeAction={bulkCloseAction}
        />
      )}

      <OfferingHistorySection history={view.history} />

      {view.work && (
        <section className="mt-8">
          <h2 className="text-lg font-bold">작업</h2>
          <p className="mt-1 text-xs text-gray-500">
            수정은 이 화면에서만 할 수 있습니다. 마감·재개·폐강·삭제는 목록 화면과 같은 기능입니다(상태 변경은 같은 서버 기능을 거칩니다).
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            {view.work.canEdit ? (
              <EditPanel offeringId={view.offeringId} {...view.work.edit} updateAction={updateAction} />
            ) : (
              <p className="text-xs text-gray-500">폐강된 개설강의는 수정할 수 없습니다.</p>
            )}
            {view.work.toggle && (
              <ActionForm
                action={toggleAction.bind(null, view.offeringId, view.work.toggle.nextStatus)}
                className="flex items-center gap-1"
              >
                <Input
                  name="reason"
                  required
                  placeholder={view.work.toggle.placeholder}
                  className="h-8 w-32 text-xs"
                />
                <ActionFormSubmitButton className="text-sm text-blue-600 underline disabled:text-gray-400">
                  {view.work.toggle.label}
                </ActionFormSubmitButton>
                <ActionFormError className="text-xs text-red-600" />
              </ActionForm>
            )}
            <OfferingEndControls
              offeringId={view.offeringId}
              title={view.title}
              canEnd={view.work.end.canEnd}
              canCancelEnd={view.work.end.canCancelEnd}
              openRefundRequestCount={view.work.end.openRefundRequestCount}
              endAction={endAction}
              cancelEndAction={cancelEndAction}
            />
            <OfferingCancelControls
              offeringId={view.offeringId}
              // 종료된 강의는 폐강할 수 없다(DB가 거부) — 종료를 취소해야 폐강 컨트롤이 다시 나온다. "ENDED"는 어느 폐강 컨트롤 분기에도 안 걸리는 값이다.
              status={view.work.end.canCancelEnd ? "ENDED" : view.work.status}
              courseName={view.work.courseName}
              label={view.work.labelRaw}
              cancelAction={cancelAction}
              completeAction={completeCancelAction}
              revokeAction={revokeCancelAction}
              completeBlockedText={view.orders.processing?.completeBlockedText ?? null}
            />
            {view.work.canDelete && (
              <ActionForm
                action={deleteAction.bind(null, view.offeringId)}
                className="flex items-center gap-1"
              >
                <Input
                  name="reason"
                  required
                  placeholder="삭제 사유"
                  className="h-8 w-32 text-xs"
                />
                <ActionFormSubmitButton className="text-sm text-red-600 underline disabled:text-gray-400">
                  삭제
                </ActionFormSubmitButton>
                <ActionFormError className="text-xs text-red-600" />
              </ActionForm>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
