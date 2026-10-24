"use client";

import type { ActionResult } from "@/lib/errors";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { Input } from "@/ui/shadcn/input";

export type ClearSwitchAction = (
  switchId: string,
  prevState: ActionResult | null,
  formData: FormData,
) => Promise<ActionResult>;

// 활성 스위치 한 줄의 해제 컨트롤 — 사유 입력 + 해제 버튼(학생 제한 해제 때부터 쓰던 모양). 해제 사유는 필수다.
export function SwitchClearForm({ switchId, clearAction }: { switchId: string; clearAction: ClearSwitchAction }) {
  return (
    <ActionForm action={clearAction.bind(null, switchId)} className="flex items-center gap-1">
      <Input name="reason" required placeholder="해제 사유" className="h-8 w-32 text-xs" />
      <ActionFormSubmitButton className="text-sm text-blue-600 underline disabled:text-gray-400">해제</ActionFormSubmitButton>
      <ActionFormError className="text-xs text-red-600" />
    </ActionForm>
  );
}
