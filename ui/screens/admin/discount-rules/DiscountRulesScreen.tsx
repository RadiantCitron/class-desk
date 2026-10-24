import type { ActionResult } from "@/lib/errors";
import { ActionForm, ActionFormError, ActionFormSubmitButton, type FormAction } from "@/ui/forms/ActionForm";
import { Input } from "@/ui/shadcn/input";
import { NativeSelect, NativeSelectOption } from "@/ui/shadcn/native-select";
import { Textarea } from "@/ui/shadcn/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/shadcn/table";
import type { AdminDiscountRulesView } from "@/ui/views/admin/discount-rules";

export type DiscountRulesScreenProps = {
  view: AdminDiscountRulesView;
  createAction: FormAction;
  deleteAction: (ruleId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
};

export function DiscountRulesScreen({ view, createAction, deleteAction }: DiscountRulesScreenProps) {
  return (
    <main className="mx-auto w-full max-w-2xl p-8">
      <h1 className="text-xl font-bold">수강료 산정기준(할인) 관리</h1>
      <p className="mt-2 text-sm text-gray-500">
        여기서 등록한 산정기준은 개설강의 관리 화면에서 수강신청 건에 적용할 수 있습니다.
      </p>

      <ActionForm action={createAction} className="mt-6 grid grid-cols-2 gap-2 rounded border p-4 text-sm">
        <h2 className="col-span-2 font-medium">새 산정기준 등록</h2>

        <Input name="name" placeholder="이름 (예: 얼리버드 20% 할인)" required className="col-span-2" />

        <NativeSelect name="discount_type" required defaultValue="">
          <NativeSelectOption value="">할인 방식</NativeSelectOption>
          <NativeSelectOption value="PERCENT">정률(%)</NativeSelectOption>
          <NativeSelectOption value="FIXED">정액(원)</NativeSelectOption>
        </NativeSelect>
        <Input name="discount_value" type="number" min={0} placeholder="할인값" required />

        <label className="col-span-2 flex flex-col gap-1">
          설명
          <Textarea name="description" />
        </label>

        <label className="flex flex-col gap-1">
          시작일
          <Input name="valid_from" type="date" />
        </label>
        <label className="flex flex-col gap-1">
          종료일
          <Input name="valid_until" type="date" />
        </label>

        <ActionFormError className="col-span-2" />
        <ActionFormSubmitButton variant="default" className="col-span-2 mt-2 self-start">
          등록
        </ActionFormSubmitButton>
      </ActionForm>

      <Table className="mt-6">
        <TableHeader>
          <TableRow>
            <TableHead>이름</TableHead>
            <TableHead>할인</TableHead>
            <TableHead>기간</TableHead>
            <TableHead className="w-40"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.rules.map((rule) => (
            <TableRow key={rule.id}>
              <TableCell className="py-2">
                {rule.name}
                {rule.description && <p className="text-xs text-gray-400">{rule.description}</p>}
              </TableCell>
              <TableCell>{rule.discountText}</TableCell>
              <TableCell className="text-xs text-gray-500">{rule.periodText}</TableCell>
              <TableCell>
                <ActionForm action={deleteAction.bind(null, rule.id)} className="flex items-center gap-1">
                  <Input
                    name="reason"
                    required
                    placeholder="삭제 사유"
                    className="h-8 w-28 text-xs"
                  />
                  <ActionFormSubmitButton className="text-red-600 underline disabled:text-gray-400">
                    삭제
                  </ActionFormSubmitButton>
                  <ActionFormError className="text-xs text-red-600" />
                </ActionForm>
              </TableCell>
            </TableRow>
          ))}
          {view.rules.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="py-4 text-gray-400">
                등록된 산정기준이 없습니다.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </main>
  );
}
