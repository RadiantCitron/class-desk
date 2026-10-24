"use client";

import { useState } from "react";
import type { ActionResult } from "@/lib/errors";
import type { AdminSystemView } from "@/ui/views/admin/system";
import { Modal } from "@/ui/forms/Modal";
import { ResultDialog } from "@/ui/forms/ResultDialog";
import { useResultAction } from "@/ui/forms/useResultAction";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { NativeSelect } from "@/ui/shadcn/native-select";
import { Input } from "@/ui/shadcn/input";
import { Textarea } from "@/ui/shadcn/textarea";

export type SetSwitchAction = (prevState: ActionResult | null, formData: FormData) => Promise<ActionResult>;

type Level = "SYSTEM" | "MODULE" | "COMMAND";

// 스위치 설정 창 — 층(시스템/모듈/명령·조회) → 대상(등록부에서 고르는 목록) → 유저(비우면 전원) → 사유(필수).
// 창 자체가 확인 단계다(배경·ESC로 닫히지 않는 Modal). 시스템 전체를 전원에게 켤 때는 영향이 가장 크므로 경고 문구를 따로 보인다.
// 결과는 창이 닫혀도 남는 이 컴포넌트가 ResultDialog로 알린다(useResultAction).
export function SwitchSetPanel({
  options,
  prefillUserEmail,
  setSwitchAction,
}: {
  options: AdminSystemView["switches"]["options"];
  prefillUserEmail: string | null;
  setSwitchAction: SetSwitchAction;
}) {
  const setting = useResultAction(setSwitchAction);
  return (
    <>
      <Modal triggerLabel="스위치 설정" title="통제 스위치 설정">
        <SwitchSetForm options={options} prefillUserEmail={prefillUserEmail} action={setting.action} />
      </Modal>
      {setting.result && (
        <ResultDialog
          ok={setting.result.ok}
          message={setting.result.ok ? "스위치를 설정했습니다." : setting.result.message}
          onClose={setting.clear}
        />
      )}
    </>
  );
}

function SwitchSetForm({
  options,
  prefillUserEmail,
  action,
}: {
  options: AdminSystemView["switches"]["options"];
  prefillUserEmail: string | null;
  action: SetSwitchAction;
}) {
  const [level, setLevel] = useState<Level>("COMMAND");
  const [userEmail, setUserEmail] = useState(prefillUserEmail ?? "");
  const systemForEveryone = level === "SYSTEM" && userEmail.trim() === "";

  return (
    <ActionForm action={action} closeModalOnDone className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        층
        <NativeSelect name="level" value={level} onChange={(event) => setLevel(event.target.value as Level)}>
          <option value="SYSTEM">시스템 전체 — 모든 명령·조회</option>
          <option value="MODULE">모듈 하나 — 그 모듈의 모든 명령·조회</option>
          <option value="COMMAND">명령·조회 하나</option>
        </NativeSelect>
      </label>

      {level === "MODULE" && (
        <label className="flex flex-col gap-1 text-sm">
          대상 모듈
          <NativeSelect name="target" defaultValue="" required>
            <option value="" disabled>
              모듈을 고르세요
            </option>
            {options.modules.map((module) => (
              <option key={module.value} value={module.value}>
                {module.label}
              </option>
            ))}
          </NativeSelect>
        </label>
      )}

      {level === "COMMAND" && (
        <label className="flex flex-col gap-1 text-sm">
          대상 명령·조회
          <NativeSelect name="target" defaultValue="" required>
            <option value="" disabled>
              명령·조회를 고르세요
            </option>
            {options.commandGroups.map((group) => (
              <optgroup key={group.moduleLabel} label={group.moduleLabel}>
                {group.items.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label} ({item.kindLabel})
                  </option>
                ))}
              </optgroup>
            ))}
          </NativeSelect>
        </label>
      )}

      <label className="flex flex-col gap-1 text-sm">
        유저 이메일(비우면 전원)
        <Input
          name="userEmail"
          type="email"
          value={userEmail}
          onChange={(event) => setUserEmail(event.target.value)}
          placeholder="예: student@example.com"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        설정 사유(필수)
        <Textarea name="reason" required rows={3} placeholder="예: PG사 점검, 결제 분쟁 조사 중" />
      </label>

      {systemForEveryone ? (
        <p role="alert" className="rounded-sm border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          스위치 화면을 제외한 모든 명령·조회가 관리자 포함 전원에게 멈춥니다. 로그인은 되지만 그 뒤의 화면과 조작이 모두 막힙니다. 이 화면의
          해제는 봉쇄 중에도 할 수 있습니다.
        </p>
      ) : (
        <p className="text-sm text-gray-600">
          지금부터 {userEmail.trim() ? "그 회원" : "전원"}에게 해당 범위의 명령·조회가 막힙니다. 관리자도 예외가 아닙니다. 해제는 이 화면에서
          사유와 함께 언제든 할 수 있고, 설정·해제 이력은 지워지지 않습니다.
        </p>
      )}

      <ActionFormError />
      <ActionFormSubmitButton variant="destructive" className="self-start">
        설정 확정
      </ActionFormSubmitButton>
    </ActionForm>
  );
}
