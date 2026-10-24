"use client";

import type { ActionResult } from "@/lib/errors";
import { Modal } from "@/ui/forms/Modal";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { ResultDialog } from "@/ui/forms/ResultDialog";
import { useResultAction } from "@/ui/forms/useResultAction";
import { Input } from "@/ui/shadcn/input";
import { Textarea } from "@/ui/shadcn/textarea";
import type { OfferingDetailView } from "@/ui/views/admin/course-offering-detail";
import { SessionPicker } from "./SessionPicker";

export type SessionAddAction = (offeringId: string, prev: ActionResult<string> | null, fd: FormData) => Promise<ActionResult<string>>;
export type SessionCancelAction = (
  offeringId: string,
  sessionId: string,
  prev: ActionResult<string> | null,
  fd: FormData,
) => Promise<ActionResult<string>>;

export type SessionCorrectAction = (
  offeringId: string,
  sessionId: string,
  prev: ActionResult<string> | null,
  fd: FormData,
) => Promise<ActionResult<string>>;

export type ScheduleChangeAction = (offeringId: string, prev: ActionResult<string> | null, fd: FormData) => Promise<ActionResult<string>>;
export type ScheduleExcludeAction = (orderId: string, prev: ActionResult<string> | null, fd: FormData) => Promise<ActionResult<string>>;
type ScheduleChangeView = Extract<OfferingDetailView, { kind: "ok" }>["scheduleChange"];

type SessionItem = {
  id: string;
  text: string;
  active: boolean;
  deactivatedText: string | null;
  hasStarted: boolean;
  date: string;
  start: string;
  end: string;
};

// 관리자 상세 「일정」 절. 회차 목록 + 개강 전·신청 없음일 때만 보이는 「취소」 버튼과 「회차 추가」 폼.
// 이미 시작된 회차는 「기록 정정」으로 과거/진행 시각 정정.
function SessionRow({
  offeringId,
  session,
  canEdit,
  cancelAction,
  correctAction,
}: {
  offeringId: string;
  session: SessionItem;
  canEdit: boolean;
  cancelAction: SessionCancelAction;
  correctAction?: SessionCorrectAction;
}) {
  const cancel = useResultAction(cancelAction.bind(null, offeringId, session.id));
  const correct = useResultAction(correctAction ? correctAction.bind(null, offeringId, session.id) : async () => ({ ok: false, message: "동작 불가" }));
  return (
    <li className="flex flex-wrap items-center gap-2" data-testid={`session-${session.id}`}>
      <span className={session.active ? "" : "text-gray-400 line-through"}>{session.text}</span>
      {session.deactivatedText && <span className="text-xs text-gray-400">{session.deactivatedText}</span>}
      {canEdit && session.active && (
        <Modal triggerLabel="취소" title="이 회차를 취소할까요?">
          <ActionForm action={cancel.action} closeModalOnDone className="flex flex-col gap-3">
            <p className="text-sm text-gray-600">
              {session.text} 회차를 취소합니다. 기록은 삭제되지 않고 비활성으로 남으며, 개강·종료가 남은 회차로 다시 계산됩니다. 시각이나 날짜를 바꾸려면
              취소한 뒤 새 회차를 추가하세요.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              취소 사유(필수)
              <Input name="reason" required placeholder="예: 강사 일정으로 날짜 변경" />
            </label>
            <ActionFormSubmitButton variant="destructive" className="self-start">
              회차 취소 확정
            </ActionFormSubmitButton>
            <ActionFormError className="text-xs text-red-600" />
          </ActionForm>
        </Modal>
      )}
      {session.active && session.hasStarted && correctAction && (
        <Modal triggerLabel="기록 정정" title="지난 회차 기록 정정">
          <ActionForm action={correct.action} closeModalOnDone className="flex flex-col gap-3">
            <p className="text-sm text-gray-600">
              수업한 사실을 바로잡는 것이며 수강생에게 알리지 않습니다. 새 날짜와 시각도 이미 시작된 과거 또는 진행 중인 시각이어야 합니다.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              날짜
              <Input type="date" name="date" required defaultValue={session.date} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-sm">
                시작 시각
                <Input type="time" name="start" required defaultValue={session.start} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                종료 시각
                <Input type="time" name="end" required defaultValue={session.end} />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              정정 사유(필수)
              <Input name="reason" required placeholder="예: 10분 지연 시작 및 연장 진행" />
            </label>
            <ActionFormSubmitButton className="self-start">
              기록 정정 확정
            </ActionFormSubmitButton>
            <ActionFormError className="text-xs text-red-600" />
          </ActionForm>
        </Modal>
      )}
      {cancel.result && (
        <ResultDialog
          ok={cancel.result.ok}
          message={cancel.result.ok ? (typeof cancel.result.data === "string" ? cancel.result.data : "처리되었습니다.") : cancel.result.message}
          onClose={cancel.clear}
        />
      )}
      {correct.result && (
        <ResultDialog
          ok={correct.result.ok}
          message={correct.result.ok ? (typeof correct.result.data === "string" ? correct.result.data : "처리되었습니다.") : correct.result.message}
          onClose={correct.clear}
        />
      )}
    </li>
  );
}

const EXCLUDE_TEXT: Record<"REFUND" | "NO_REFUND", string> = {
  REFUND: "카드로 결제한 금액의 잔액 전부를 PG에 환불 요청하고, 환불이 반영되면 수업에서 제외하며 이용권·디스코드 역할을 회수합니다.",
  NO_REFUND: "환불할 결제가 없으므로 바로 수업에서 제외하고 이용권·디스코드 역할을 회수하며 좌석을 돌려놓습니다.",
};

function ResponseRow({ row, exclude }: { row: ScheduleChangeView["responses"][number]; exclude: ReturnType<typeof useResultAction<string>> }) {
  return (
    <tr className="border-b" data-testid={`schedule-response-${row.orderId}`}>
      <td className="py-1 pr-2">
        <a href={row.href} className="underline">
          {row.email}
        </a>
      </td>
      <td className="pr-2">{row.paymentText}</td>
      <td className="pr-2" data-testid="schedule-response-status">
        {row.statusLabel}
        <span className="ml-1 text-xs text-gray-500">(안내 후 {row.ageDays}일)</span>
        {row.emailedAt && <span className="ml-2 text-xs text-blue-600">· 메일 발송됨({row.emailedAt})</span>}
      </td>
      <td>
        {row.excludeKind === "NO_REFUND" ? (
          <Modal triggerLabel="제외 처리" title="이 수강생을 수업에서 제외할까요?">
            <ActionForm action={exclude.action} closeModalOnDone className="flex flex-col gap-3">
              <input type="hidden" name="order_id" value={row.orderId} />
              <p className="rounded-sm bg-orange-50 px-3 py-2 text-sm font-medium text-orange-900">
                {row.email} · {row.statusLabel}
              </p>
              <p className="text-sm text-gray-600">
                환불할 결제가 없으므로 바로 수업에서 제외하고 이용권·디스코드 역할을 회수하며 좌석을 돌려놓습니다. <b>되돌릴 수 없습니다.</b>
              </p>
              <label className="flex flex-col gap-1 text-sm">
                제외 사유(필수)
                <Textarea name="memo" required rows={2} placeholder="예: 일정 변경으로 인한 수강 취소 요청" />
              </label>
              <ActionFormSubmitButton variant="destructive" className="self-start">
                제외 처리 확정
              </ActionFormSubmitButton>
              <ActionFormError className="text-xs text-red-600" />
            </ActionForm>
          </Modal>
        ) : (
          <span className="text-xs text-gray-500">결제 수강생 (선별 환불 또는 주문 상세에서 처리)</span>
        )}
      </td>
    </tr>
  );
}

export function OfferingSessionsSection({
  offeringId,
  sessions,
  canEdit,
  lockText,
  progressText,
  scheduleChange,
  addAction,
  cancelAction,
  correctAction,
  changeAction,
  excludeAction,
}: {
  offeringId: string;
  sessions: SessionItem[];
  progressText: string;
  canEdit: boolean;
  lockText: string | null;
  scheduleChange: ScheduleChangeView;
  addAction: SessionAddAction;
  cancelAction: SessionCancelAction;
  correctAction?: SessionCorrectAction;
  changeAction: ScheduleChangeAction;
  excludeAction: ScheduleExcludeAction;
}) {
  const add = useResultAction(addAction.bind(null, offeringId));
  const change = useResultAction(changeAction.bind(null, offeringId));
  const exclude = useResultAction((prev: ActionResult<string> | null, fd: FormData) => excludeAction(String(fd.get("order_id") ?? ""), prev, fd));
  return (
    <section className="mt-8" data-testid="sessions-section">
      <h2 className="text-lg font-bold">일정</h2>
      {progressText && (
        <p className="mt-1 text-sm text-gray-600" data-testid="sessions-progress">
          {progressText}
        </p>
      )}
      {sessions.length === 0 ? (
        <p className="mt-2 text-sm text-gray-400">등록된 회차가 없습니다.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              offeringId={offeringId}
              session={s}
              canEdit={canEdit}
              cancelAction={cancelAction}
              correctAction={correctAction}
            />
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="mt-3">
          <Modal triggerLabel="회차 추가" title="회차 추가">
            <ActionForm action={add.action} closeModalOnDone className="flex flex-col gap-3 text-sm">
              <p className="text-gray-600">
                개강 전이고 신청이 없는 수업에서만 추가할 수 있습니다. 가장 이른 날짜를 더하면 개강이 앞당겨지고, 같은 날짜·시간대가 겹치는 회차는 거부됩니다.
              </p>
              <label className="flex flex-col gap-1">
                날짜
                <Input name="date" type="date" required />
              </label>
              <div className="flex gap-3">
                <label className="flex flex-col gap-1">
                  시작 시각
                  <Input name="start" type="time" required />
                </label>
                <label className="flex flex-col gap-1">
                  종료 시각
                  <Input name="end" type="time" required />
                </label>
              </div>
              <label className="flex flex-col gap-1">
                추가 사유(필수)
                <Input name="reason" required placeholder="예: 보강" />
              </label>
              <ActionFormSubmitButton className="self-start">회차 추가 확정</ActionFormSubmitButton>
              <ActionFormError className="text-xs text-red-600" />
            </ActionForm>
          </Modal>
        </div>
      ) : (
        lockText && (
          <p className="mt-2 text-xs text-gray-500" data-testid="sessions-lock">
            {lockText}
          </p>
        )
      )}
      {scheduleChange.canChange ? (
        <div className="mt-3" data-testid="schedule-change">
          {scheduleChange.hasDuplicateDates ? (
            <p className="text-xs text-gray-500">같은 날짜에 회차가 둘 이상이라 이 화면(날짜당 1회차)으로는 일정을 바꿀 수 없습니다.</p>
          ) : (
            <Modal triggerLabel="일정 변경" title="일정을 변경할까요?">
              <ActionForm action={change.action} closeModalOnDone className="flex flex-col gap-3 text-sm">
                <p className="rounded-sm bg-orange-50 px-3 py-2 text-orange-900">
                  {scheduleChange.liveOrderCount > 0
                    ? `신청(승인 대기·승인됨) ${scheduleChange.liveOrderCount}명에게 일정 변경이 안내됩니다. 변경된 일정으로 참여가 어려운 수강생은 환불을 신청할 수 있으며, 관리자가 선별 일괄 환불 또는 개별 환불로 처리합니다.`
                    : "신청한 수강생이 없어 안내 없이 일정만 바뀝니다."}
                </p>
                {scheduleChange.isImminent && (
                  <p className="rounded-sm bg-red-50 px-3 py-2 text-red-900 text-xs font-semibold">
                    ⚠️ 시작 2시간 이내로 임박한 회차가 포함되어 있습니다. 수강생이 혼란을 겪을 수 있으므로 신중히 변경해 주세요.
                  </p>
                )}
                <p className="text-gray-600">
                  달력에서 날짜를 더하거나 빼고 시각을 고치세요. 이미 시작된 회차는 변경하거나 취소할 수 없습니다. 바꾼 뒤에도 시작 전 활성 회차가 1개 이상 남아 있어야 합니다.
                </p>
                <SessionPicker defaultSessions={scheduleChange.currentSessions} lockedDates={scheduleChange.lockedDates} />
                <label className="flex flex-col gap-1">
                  장소 (오프라인 강의 장소 변경 시 입력)
                  <Input name="location" defaultValue={scheduleChange.currentLocation} placeholder="예: 역삼역 강의실" />
                </label>
                <label className="flex flex-col gap-1">
                  변경 사유(필수 — 수강생에게도 안내됩니다)
                  <Textarea name="reason" required rows={2} maxLength={500} placeholder="예: 강사 사정으로 둘째 날 일정 및 장소가 바뀝니다" />
                </label>
                <div className="rounded border bg-gray-50 p-3">
                  <label className="flex items-center gap-2 text-xs font-semibold text-gray-800">
                    <input type="checkbox" name="update_notice" className="rounded" />
                    공지문도 함께 게시
                  </label>
                  <p className="mt-1 text-xs text-gray-500">
                    체크하면 입력한 공지문이 강의 상단 공지로 동시 반영됩니다.
                  </p>
                  <Textarea
                    name="notice"
                    rows={2}
                    maxLength={1000}
                    placeholder="예: 둘째 날 수업 일정이 변경되었으니 확인 부탁드립니다."
                    className="mt-2 text-xs"
                  />
                </div>
                <ActionFormSubmitButton variant="destructive" className="self-start">
                  일정 변경 확정
                </ActionFormSubmitButton>
                <ActionFormError className="text-xs text-red-600" />
              </ActionForm>
            </Modal>
          )}
        </div>
      ) : (
        scheduleChange.changeLockText && (
          <p className="mt-2 text-xs text-gray-500" data-testid="schedule-change-lock">
            {scheduleChange.changeLockText}
          </p>
        )
      )}
      {scheduleChange.responses.length > 0 && (
        <div className="mt-4 rounded-sm border border-blue-200 bg-blue-50 p-3" data-testid="schedule-responses">
          <h3 className="text-sm font-medium text-blue-900">일정 변경 안내 현황</h3>
          <p className="mt-1 text-xs text-blue-800">
            가장 최근 일정 변경 안내 대상 수강생입니다. 결제 수강생은 선별 일괄 환불로 처리하고, 미결제·무료 수강생은 필요시 제외 처리하세요.
          </p>
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr className="border-b text-xs text-gray-600">
                <th className="py-1 pr-2">수강생</th>
                <th className="pr-2">결제</th>
                <th className="pr-2">응답</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {scheduleChange.responses.map((r) => (
                <ResponseRow key={r.orderId} row={r} exclude={exclude} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {exclude.result && (
        <ResultDialog
          ok={exclude.result.ok}
          message={exclude.result.ok ? (typeof exclude.result.data === "string" ? exclude.result.data : "처리되었습니다.") : exclude.result.message}
          onClose={exclude.clear}
        />
      )}
      {change.result && (
        <ResultDialog
          ok={change.result.ok}
          message={change.result.ok ? (typeof change.result.data === "string" ? change.result.data : "처리되었습니다.") : change.result.message}
          onClose={change.clear}
        />
      )}
      {add.result && (
        <ResultDialog
          ok={add.result.ok}
          message={add.result.ok ? (typeof add.result.data === "string" ? add.result.data : "처리되었습니다.") : add.result.message}
          onClose={add.clear}
        />
      )}
    </section>
  );
}
