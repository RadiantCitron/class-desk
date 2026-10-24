import Link from "next/link";
import type { ActionResult } from "@/lib/errors";
import type { StudentHomeView } from "@/ui/views/student/home";
import { Alert, AlertDescription } from "@/ui/shadcn/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/shadcn/table";
import { CopyButton } from "@/ui/forms/CopyButton";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { StudentRefundRequest, type RequestRefundAction } from "./StudentRefundRequest";
import { StudentScheduleChange } from "./StudentScheduleChange";

export function StudentHomeScreen({
  view,
  cancelAction,
  requestRefundAction,
}: {
  view: StudentHomeView;
  cancelAction: (orderId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  requestRefundAction: RequestRefundAction;
}) {
  if (view.kind === "restricted") {
    return (
      <main className="mx-auto w-full max-w-xl p-8">
        <h1 className="text-xl font-bold">이용 제한</h1>
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>
            <p>{view.message}</p>
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-xl p-8">
      <h1 className="text-xl font-bold">내 수강</h1>

      {view.paidBanner && (
        <Alert className="mt-4 border-green-200 bg-green-50 text-green-800">
          <AlertDescription>
            <p>결제가 확인되었습니다. 아래 내 수강 내역에서 결제 상태를 확인할 수 있습니다.</p>
          </AlertDescription>
        </Alert>
      )}

      {view.cancellationBanners.length > 0 && (
        <Alert className="mt-4 border-orange-200 bg-orange-50 text-orange-900">
          <AlertDescription>
            <p className="font-medium">폐강된 강의가 있습니다.</p>
            <ul className="mt-1 list-disc pl-5">
              {view.cancellationBanners.map((b) => (
                <li key={b.offeringId}>{b.text}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {view.enrollments.some((r) => r.scheduleChange?.status === "NOTIFIED") && (
        <Alert className="mt-4 border-orange-300 bg-orange-50 text-orange-900" data-testid="schedule-change-banner">
          <AlertDescription>
            <p className="font-medium">신청하신 수업의 일정이 변경되었습니다.</p>
            <ul className="mt-1 list-disc pl-5">
              {view.enrollments
                .filter((r) => r.scheduleChange?.status === "NOTIFIED")
                .map((r) => (
                  <li key={r.id}>{r.courseText}: 아래 내 수강 내역에서 변경된 일정을 확인해 주세요. 변경된 일정 참여가 어렵다면 「이 변경으로 환불 신청」을 눌러 주시면 됩니다.</li>
                ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {view.awaitingPayment.length > 0 && (
        <Alert className="mt-4 border-green-200 bg-green-50 text-green-800">
          <AlertDescription>
            <p className="font-medium">승인된 신청이 있습니다 — 결제를 진행해 주세요.</p>
            <ul className="mt-1 list-disc pl-5">
              {view.awaitingPayment.map((item) => (
                <li key={item.id}>
                  {item.courseText} —{" "}
                  <Link href={item.href} className="underline">
                    결제하러 가기
                  </Link>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {view.discordId ? (
        <div className="mt-2 flex items-center gap-2 text-sm text-gray-600">
          <span>
            디스코드 ID: <span className="font-mono">{view.discordId}</span>
          </span>
          <CopyButton text={view.discordId} />
        </div>
      ) : view.hasDiscordOffering ? (
        <Alert className="mt-4 border-blue-200 bg-blue-50 text-blue-800">
          <AlertDescription>
            <p>
              온라인(디스코드) 수업은 디스코드 계정을 연결해야 신청할 수 있습니다.{" "}
              <Link href="/student/profile" className="underline">
                내 정보에서 디스코드 연결하기
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <h2 className="mt-8 text-lg font-bold">내 수강 내역</h2>
      <Table className="mt-4">
        <TableHeader>
          <TableRow>
            <TableHead>강의</TableHead>
            <TableHead>수강상태</TableHead>
            <TableHead>결제상태</TableHead>
            <TableHead className="w-0"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.enrollments.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="py-4 text-sm text-gray-400">
                아직 신청한 강의가 없습니다.
              </TableCell>
            </TableRow>
          ) : (
            view.enrollments.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  {row.courseText}
                  {row.winddown === "progress" && (
                    <span className="ml-1 text-xs text-orange-700">(폐강 진행 중)</span>
                  )}
                  {row.winddown === "done" && (
                    <span className="ml-1 text-xs text-gray-500">(폐강 완료)</span>
                  )}
                  {row.lifecycleText && (
                    <span className="ml-1 text-xs text-gray-500" data-testid="lifecycle-text">
                      ({row.lifecycleText})
                    </span>
                  )}
                  {row.notice && (
                    <div className="mt-1 whitespace-pre-wrap rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900" data-testid="student-enrollment-notice">
                      <span className="font-semibold">[공지] </span>{row.notice}
                    </div>
                  )}
                </TableCell>
                <TableCell>{row.orderStatusText}</TableCell>
                <TableCell>
                  {row.paymentStatusText}
                  {row.refundedText && (
                    <span className="ml-1 text-xs text-gray-400">{row.refundedText}</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    {row.unavailableText ? (
                      <span className="text-gray-400">{row.unavailableText}</span>
                    ) : (
                      row.payLink && (
                        <Link href={row.payLink.href} className="text-blue-600 underline">
                          {row.payLink.label}
                        </Link>
                      )
                    )}
                    {row.canCancel && (
                      <ActionForm action={cancelAction.bind(null, row.id)}>
                        <ActionFormSubmitButton className="text-red-600 underline disabled:text-gray-400">
                          신청 취소
                        </ActionFormSubmitButton>
                        <ActionFormError className="text-xs text-red-600" />
                      </ActionForm>
                    )}
                    {(row.refund?.kind === "AVAILABLE" || row.refund?.kind === "REQUESTED") && (
                      <StudentRefundRequest
                        orderId={row.id}
                        courseText={row.courseText}
                        refund={row.refund}
                        requestAction={requestRefundAction}
                      />
                    )}
                    {row.refund?.kind === "BLOCKED" && (
                      <span className="text-xs text-gray-500" data-testid="refund-blocked">
                        {row.refund.text}
                      </span>
                    )}
                    {row.scheduleChange && (
                      <StudentScheduleChange
                        orderId={row.id}
                        courseText={row.courseText}
                        change={row.scheduleChange}
                        canRequestRefund={row.refund?.kind === "AVAILABLE"}
                        requestRefundAction={requestRefundAction}
                      />
                    )}
                    {row.refundRejectedText && (
                      <span className="text-xs text-red-700" data-testid="refund-rejected">
                        {row.refundRejectedText}
                      </span>
                    )}
                    {row.showRefundHint && (
                      <span className="text-xs text-gray-500">환불은 관리자에게 문의해 주세요</span>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <h2 className="mt-8 text-lg font-bold">개설 강의</h2>
      {view.offerings.length === 0 ? (
        <p className="mt-2 text-sm text-gray-400">현재 개설된 강의가 없습니다.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {view.offerings.map((offering) => (
            <li key={offering.id} className="flex items-center justify-between rounded border p-3 text-sm">
              <div>
                <p className="font-medium">{offering.title}</p>
                <p className="text-gray-500">{offering.meta}</p>
                {offering.scheduleText && <p className="text-gray-500">일정: {offering.scheduleText}</p>}
                {offering.description && (
                  <p className="mt-1 max-w-xs whitespace-pre-wrap text-xs text-gray-400">{offering.description}</p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                {offering.appliedLabel ? (
                  <span className="text-xs text-gray-400">{offering.appliedLabel}</span>
                ) : (
                  <>
                    <Link
                      href={offering.applyHref}
                      aria-disabled={!offering.canApply}
                      className={
                        offering.canApply
                          ? "rounded bg-black px-3 py-1.5 text-xs text-white"
                          : "cursor-not-allowed rounded bg-gray-200 px-3 py-1.5 text-xs text-gray-400"
                      }
                    >
                      {offering.buttonText}
                    </Link>
                    {offering.discordNotice && (
                      <span className="text-xs text-blue-600">{offering.discordNotice}</span>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
