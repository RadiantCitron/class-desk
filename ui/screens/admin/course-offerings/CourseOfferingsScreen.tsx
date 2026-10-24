import Link from "next/link";
import type { ActionResult } from "@/lib/errors";
import { ActionForm, ActionFormError, ActionFormSubmitButton, type FormAction } from "@/ui/forms/ActionForm";
import { checkboxClass } from "@/ui/forms/controls";
import { Input } from "@/ui/shadcn/input";
import { NativeSelect, NativeSelectOption } from "@/ui/shadcn/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/shadcn/table";
import type { AdminCourseOfferingsView } from "@/ui/views/admin/course-offerings";
import { OfferingCancelControls, type OfferingAction } from "./OfferingCancelControls";
import { OnlineCourseFields } from "./OnlineCourseFields";
import { SessionPicker } from "./SessionPicker";

export type CourseOfferingsScreenProps = {
  view: AdminCourseOfferingsView;
  createAction: FormAction;
  autoApproveAction: (offeringId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  toggleAction: (
    offeringId: string,
    nextStatus: "OPEN" | "CLOSED",
    prev: ActionResult | null,
    fd: FormData,
  ) => Promise<ActionResult>;
  deleteAction: (offeringId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  cancelAction: OfferingAction;
  completeCancelAction: OfferingAction;
  drainAction: FormAction;
};

export function CourseOfferingsScreen({
  view,
  createAction,
  autoApproveAction,
  toggleAction,
  deleteAction,
  cancelAction,
  completeCancelAction,
  drainAction,
}: CourseOfferingsScreenProps) {
  return (
    <main className="mx-auto w-full max-w-3xl p-8">
      <h1 className="text-xl font-bold">개설강의 관리</h1>
      <p className="mt-2 text-sm text-gray-500">
        강의(과목)가 먼저 있어야 개설할 수 있습니다.{" "}
        <Link href="/admin/courses" className="underline">
          강의 관리
        </Link>
        에서 먼저 등록해 주세요.
      </p>

      <ActionForm action={createAction} className="mt-6 grid grid-cols-2 gap-2 rounded border p-4 text-sm">
        <h2 className="col-span-2 font-medium">새 개설강의 등록</h2>

        <NativeSelect name="course_id" required defaultValue="" className="col-span-2">
          <NativeSelectOption value="">강의(과목) 선택</NativeSelectOption>
          {view.courses.map((course) => (
            <NativeSelectOption key={course.id} value={course.id}>
              {course.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>

        <Input name="label" placeholder="회차 별칭 (예: 1기)" />
        <Input name="location" placeholder="위치 (디스코드 채널 등)" />
        <Input name="capacity" type="number" min={0} placeholder="정원" required />
        <Input name="price" type="number" min={0} placeholder="가격(원)" required />

        <OnlineCourseFields defaultOnline={false} defaultRoleId="" defaultChannelId="" mono />

        <label className="col-span-2 flex flex-col gap-1">
          소스코드 파일 경로 (선택 — 버셀 Blob pathname)
          <Input
            name="blob_pathname"
            placeholder="예: source-packs/react-dump.zip (전체 주소 말고 경로만)"
            className="font-mono text-xs"
          />
          <span className="text-xs text-gray-400">
            파일은 이 사이트에서 올리지 않습니다. 버셀 대시보드에서 Private Blob에 올린 뒤 경로만 적으세요.
            적으면 결제 완료 시 다운로드권이 1회 부여됩니다.
          </span>
        </label>

        <label className="col-span-2 flex flex-col gap-1">
          <span className="flex items-center gap-2">
            <input type="checkbox" name="auto_approve" className={checkboxClass} /> 신청 시 자동 승인
          </span>
          <span className="text-xs text-gray-400">
            켜면 학생이 신청하는 즉시 승인됩니다. 결제는 별도입니다.
          </span>
        </label>

        <label className="flex flex-col gap-1">
          모집 시작일시
          <Input name="recruit_opens_at" type="datetime-local" required />
          <span className="text-xs text-gray-400">이때부터 개강 전까지 신청을 받습니다.</span>
        </label>
        <SessionPicker />

        <fieldset className="col-span-2">
          <legend className="text-xs text-gray-500">
            이 개설강의만 추가로 요구하는 약관(공통 약관인 서비스이용약관·개인정보동의는 항상 자동으로 요구됩니다). 예: AI를 활용하는 강의는 해외이전동의를, 소스코드가 결합된 판매 방식이면 이용허락동의를 선택하세요. 해당 약관 원문은{" "}
            <Link href="/admin/terms" className="underline">
              약관 관리
            </Link>
            에서 미리 등록해야 신청 화면에 노출됩니다.
          </legend>
          <div className="mt-1 flex flex-wrap gap-3 text-xs">
            {view.termOptions.map(({ type, label }) => (
              <label key={type} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  name="required_terms_types"
                  value={type}
                  className={checkboxClass}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <ActionFormError className="col-span-2" />
        <ActionFormSubmitButton variant="default" className="col-span-2 mt-2 self-start">
          등록
        </ActionFormSubmitButton>
      </ActionForm>

      <div className="mt-6 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>강의</TableHead>
              <TableHead>회차</TableHead>
              <TableHead>정원(잔여)</TableHead>
              <TableHead>가격</TableHead>
              <TableHead>상태</TableHead>
              <TableHead>자동승인</TableHead>
              <TableHead>추가 약관</TableHead>
              <TableHead>디스코드 역할</TableHead>
              <TableHead>소스 경로</TableHead>
              <TableHead className="w-48"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.offerings.map((offering) => (
              <TableRow key={offering.id}>
                <TableCell>{offering.courseName}</TableCell>
                <TableCell>{offering.labelText}</TableCell>
                <TableCell>{offering.capacityText}</TableCell>
                <TableCell>{offering.priceText}</TableCell>
                <TableCell>
                  <span className="text-xs">{offering.statusBadge}</span>
                  {offering.status === "CANCELLING" && (
                    <p className="mt-1 text-xs text-gray-400">
                      남은 건 재처리:{" "}
                      <Link href="/admin/system" className="underline">
                        시스템
                      </Link>
                      ·
                      <Link href="/admin/dlq" className="underline">
                        DLQ
                      </Link>
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  <ActionForm
                    action={autoApproveAction.bind(null, offering.id)}
                    className="flex flex-col gap-1 text-xs"
                  >
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        name="auto_approve"
                        defaultChecked={offering.autoApprove}
                        className={checkboxClass}
                      />
                      {offering.autoApproveLabel}
                    </label>
                    <ActionFormSubmitButton className="text-blue-600 underline disabled:text-gray-400">
                      저장
                    </ActionFormSubmitButton>
                    <ActionFormError className="text-xs text-red-600" />
                  </ActionForm>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-gray-500">{offering.termsText}</span>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-gray-500">{offering.discordRoleText}</span>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs text-gray-500">{offering.sourcePathText}</span>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-2">
                    <Link href={offering.detailHref} className="text-blue-600 underline">
                      상세
                    </Link>
                    {offering.toggle && (
                      <ActionForm
                        action={toggleAction.bind(null, offering.id, offering.toggle.nextStatus)}
                        className="flex items-center gap-1"
                      >
                        <Input
                          name="reason"
                          required
                          placeholder={offering.toggle.placeholder}
                          className="h-8 w-24 text-xs"
                        />
                        <ActionFormSubmitButton className="text-blue-600 underline disabled:text-gray-400">
                          {offering.toggle.label}
                        </ActionFormSubmitButton>
                        <ActionFormError className="text-xs text-red-600" />
                      </ActionForm>
                    )}
                    <OfferingCancelControls
                      offeringId={offering.id}
                      // 종료된 강의는 폐강할 수 없다(DB가 거부) — "ENDED"는 폐강 컨트롤의 어느 분기에도 안 걸리는 값이다(상세 화면과 같은 방식).
                      status={offering.ended ? "ENDED" : offering.status}
                      courseName={offering.courseName || null}
                      label={offering.label}
                      cancelAction={cancelAction}
                      completeAction={completeCancelAction}
                    />
                    {offering.status === "CANCELLING" && (
                      <div className="flex flex-col gap-2 text-xs">
                        {offering.remainingOrders.length > 0 && (
                          <ul className="flex flex-col gap-1 text-gray-600">
                            {offering.remainingOrders.map((order) => (
                              <li key={order.id}>
                                <Link href={order.href} className="underline">
                                  {order.text}
                                </Link>
                                <span className="ml-1 font-mono text-[10px] text-gray-400">
                                  {order.shortId}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        <ActionForm action={drainAction}>
                          <ActionFormSubmitButton className="text-blue-600 underline disabled:text-gray-400">
                            남은 건 처리
                          </ActionFormSubmitButton>
                          <ActionFormError className="text-xs text-red-600" />
                        </ActionForm>
                        <p className="text-gray-400">
                          시스템 화면의 수동 드레인과 같습니다. 단건 재시도는 주문 상세에서.
                        </p>
                      </div>
                    )}
                    {offering.canDelete && (
                      <ActionForm
                        action={deleteAction.bind(null, offering.id)}
                        className="flex items-center gap-1"
                      >
                        <Input
                          name="reason"
                          required
                          placeholder="삭제 사유"
                          className="h-8 w-24 text-xs"
                        />
                        <ActionFormSubmitButton className="text-red-600 underline disabled:text-gray-400">
                          삭제
                        </ActionFormSubmitButton>
                        <ActionFormError className="text-xs text-red-600" />
                      </ActionForm>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </main>
  );
}
