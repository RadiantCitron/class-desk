"use client";

import type { ActionResult } from "@/lib/errors";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { Textarea } from "@/ui/shadcn/textarea";
import { Input } from "@/ui/shadcn/input";

export type OfferingNoticeAction = (
  offeringId: string,
  prev: ActionResult<string> | null,
  fd: FormData,
) => Promise<ActionResult<string>>;

export function OfferingNoticePanel({
  offeringId,
  currentNotice,
  noticeAction,
  disabled,
}: {
  offeringId: string;
  currentNotice: string | null;
  noticeAction: OfferingNoticeAction;
  disabled?: boolean;
}) {
  return (
    <section className="mt-8 rounded border p-4" data-testid="offering-notice-panel">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">공지문 관리</h2>
        {currentNotice && (
          <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
            게시 중
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        강의 조회 및 학생 내 수강 내역 페이지 상단에 노출되는 단일 공지문입니다. 모든 학생과 방문자에게 공개됩니다.
      </p>

      {disabled ? (
        <div className="mt-3">
          {currentNotice ? (
            <div className="whitespace-pre-wrap rounded bg-gray-50 p-3 text-xs text-gray-700">
              {currentNotice}
            </div>
          ) : (
            <p className="text-xs text-gray-400">등록된 공지문이 없습니다.</p>
          )}
          <p className="mt-2 text-xs text-gray-500">
            폐강 완료 또는 종료·삭제된 강의는 공지문을 수정할 수 없습니다.
          </p>
        </div>
      ) : (
        <ActionForm
          action={noticeAction.bind(null, offeringId)}
          className="mt-4 flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-700">
            공지 내용 (최대 1,000자, 비우고 저장 시 공지 삭제)
            <Textarea
              name="notice"
              defaultValue={currentNotice ?? ""}
              rows={3}
              maxLength={1000}
              placeholder="예: 실습실 입장 시 개인 노트북을 지참해 주시기 바랍니다."
              className="text-xs"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-700">
            수정 사유 (선택, 비우면 기본값 적용)
            <Input
              name="reason"
              placeholder="예: 준비물 안내 공지 등록"
              className="h-8 text-xs"
            />
          </label>
          <div className="flex items-center gap-2">
            <ActionFormSubmitButton className="text-xs">
              공지문 저장
            </ActionFormSubmitButton>
            <ActionFormError className="text-xs text-red-600" />
          </div>
        </ActionForm>
      )}
    </section>
  );
}
