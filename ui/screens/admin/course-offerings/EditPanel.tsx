"use client";

import type { ActionResult } from "@/lib/errors";
import { Modal } from "@/ui/forms/Modal";
import { ActionForm, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { ResultDialog } from "@/ui/forms/ResultDialog";
import { useResultAction } from "@/ui/forms/useResultAction";
import { checkboxClass } from "@/ui/forms/controls";
import { Input } from "@/ui/shadcn/input";
import { OnlineCourseFields } from "./OnlineCourseFields";

// 개설강의 수정 폼(U 단계 6). 바뀐 필드만 서버로 가도록 원래 값을 orig_*로 함께 보낸다(안 바꾼 필드를 오래된 값으로
// 덮어쓰지 않으려는 것 — 서버 액션 updateCourseOffering이 비교한다). 확정하면 입력창이 닫히고 결과 팝업이 뜬다
// (성공·실패 모두). 이 컴포넌트는 상세 페이지에서 항상 마운트돼 revalidate로 폼이 사라져도
// 결과 팝업이 남는다.
export type EditPanelProps = {
  offeringId: string;
  label: string;
  location: string;
  recruitOpensAt: string; // 모집 시작 — datetime-local 값(한국 시간)
  opensAt: string; // 개강 — datetime-local 값(한국 시간)
  endsAt: string;
  capacity: number;
  price: number;
  discordRoleId: string;
  discordChannelId: string;
  autoApprove: boolean;
  autoRefund: boolean;
  manualEnd: boolean;
  requiredTerms: string[];
  termOptions: { type: string; label: string }[];
  occupied: number;
  orderCount: number;
  paidCount: number;
  isFrozen: boolean;
  updateAction: (offeringId: string, prev: ActionResult<string> | null, fd: FormData) => Promise<ActionResult<string>>;
};

export function EditPanel(props: EditPanelProps) {
  const update = useResultAction(props.updateAction.bind(null, props.offeringId));
  const sortedTerms = [...props.requiredTerms].sort().join(",");

  return (
    <>
      <Modal triggerLabel="수정" title="개설강의 수정">
        <ActionForm action={update.action} closeModalOnDone className="flex flex-col gap-3 text-sm">
          <input type="hidden" name="orig_label" value={props.label} />
          <input type="hidden" name="orig_location" value={props.location} />
          <input type="hidden" name="orig_recruit_opens_at" value={props.recruitOpensAt} />
          <input type="hidden" name="orig_capacity" value={String(props.capacity)} />
          <input type="hidden" name="orig_price" value={String(props.price)} />
          <input type="hidden" name="orig_discord_role_id" value={props.discordRoleId} />
          <input type="hidden" name="orig_discord_channel_id" value={props.discordChannelId} />
          <input type="hidden" name="orig_auto_approve" value={String(props.autoApprove)} />
          <input type="hidden" name="orig_auto_refund" value={String(props.autoRefund)} />
          <input type="hidden" name="orig_manual_end" value={String(props.manualEnd)} />
          <input type="hidden" name="orig_required_terms_types" value={sortedTerms} />

          {props.isFrozen && (
            <div className="rounded border border-orange-200 bg-orange-50 p-2 text-xs text-orange-800">
              개강했거나 마감된 수업의 핵심 정보(가격, 정원, 모집 시작)는 수정할 수 없습니다.
            </div>
          )}

          <label className="flex flex-col gap-1">
            회차 라벨
            <Input name="label" defaultValue={props.label} />
          </label>
          <label className="flex flex-col gap-1">
            위치
            <Input name="location" defaultValue={props.location} />
            {props.orderCount > 0 && (
              <span className="text-xs text-amber-700">
                신청자가 있는 수업의 장소 변경은 수강생 안내·동의가 필요하므로 아래 「일정」 절의 「일정 변경」 팝업에서 변경해 주세요.
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1">
            모집 시작(한국 시간)
            <Input name="recruit_opens_at" type="datetime-local" required defaultValue={props.recruitOpensAt} disabled={props.isFrozen} />
          </label>
          <p className="rounded border bg-gray-50 p-2 text-xs text-gray-600" data-testid="derived-schedule">
            개강(첫 회차 시작, 이때 신청 마감): {props.opensAt ? props.opensAt.replace("T", " ") : "-"} · 종료(마지막 회차 끝):{" "}
            {props.endsAt ? props.endsAt.replace("T", " ") : "-"} (한국 시간). 개강·종료는 입력하는 값이 아니라 회차에서 계산됩니다 —
            회차(날짜)는 아래 상세 화면의 「일정」 절에서 바꿉니다.
          </p>
          <label className="flex flex-col gap-1">
            정원
            <Input name="capacity" type="number" min={0} required defaultValue={props.capacity} disabled={props.isFrozen} />
            <span className="text-xs text-gray-500">
              현재 점유 {props.occupied}명 — 이보다 작게 줄일 수 없습니다. 늘리거나 줄인 만큼 잔여 좌석도 함께 바뀝니다.
            </span>
          </label>
          <label className="flex flex-col gap-1">
            가격(원)
            <Input name="price" type="number" min={0} required defaultValue={props.price} disabled={props.isFrozen} />
            {props.orderCount > 0 && (
              <span className="text-xs text-amber-700">
                기존 신청 {props.orderCount}건은 이전 금액을 유지하고 새 신청부터 적용됩니다.
              </span>
            )}
          </label>
          <OnlineCourseFields
            defaultOnline={props.discordRoleId !== ""}
            defaultRoleId={props.discordRoleId}
            defaultChannelId={props.discordChannelId}
            paidCount={props.paidCount}
          />
          {props.paidCount > 0 && (
            <label className="flex items-center gap-2 text-xs font-medium text-blue-900 bg-blue-50 p-2 rounded">
              <input
                type="checkbox"
                name="reissue_discord"
                className={checkboxClass}
              />
              디스코드 역할 변경 시 기존 수강생({props.paidCount}명)에게 새 역할을 즉시 재부여합니다.
            </label>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="auto_approve"
              defaultChecked={props.autoApprove}
              className={checkboxClass}
            />
            신청 시 자동 승인
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="auto_refund"
              defaultChecked={props.autoRefund}
              className={checkboxClass}
            />
            환불 시 자동 환불 (켜면 약관 기준 가능 건은 사람 확인 없이 즉시 환불 요청됩니다)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="manual_end" defaultChecked={props.manualEnd} className={checkboxClass} />
            수동 종료 (켜면 종강일이 지나도 자동 종료하지 않고, 직접 종료할 때까지 경고만 합니다)
          </label>
          {props.termOptions.length > 0 && (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm">추가 약관</legend>
              {props.termOptions.map((term) => (
                <label key={term.type} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="required_terms_types"
                    value={term.type}
                    defaultChecked={props.requiredTerms.includes(term.type)}
                    className={checkboxClass}
                  />
                  {term.label}
                </label>
              ))}
            </fieldset>
          )}
          <label className="flex flex-col gap-1">
            수정 사유(필수)
            <Input name="reason" required placeholder="예: 강의장 변경" />
          </label>
          <ActionFormSubmitButton variant="default" className="self-start">
            수정 저장
          </ActionFormSubmitButton>
        </ActionForm>
      </Modal>
      {update.result && (
        <ResultDialog
          ok={update.result.ok}
          message={
            update.result.ok
              ? typeof update.result.data === "string"
                ? update.result.data
                : "수정했습니다."
              : update.result.message
          }
          onClose={update.clear}
        />
      )}
    </>
  );
}
