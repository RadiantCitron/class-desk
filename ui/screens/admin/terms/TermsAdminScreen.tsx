import Link from "next/link";
import { ActionForm, ActionFormError, ActionFormSubmitButton, type FormAction } from "@/ui/forms/ActionForm";
import { Input } from "@/ui/shadcn/input";
import { NativeSelect, NativeSelectOption } from "@/ui/shadcn/native-select";
import { Textarea } from "@/ui/shadcn/textarea";
import type { AdminTermsView } from "@/ui/views/admin/terms";

export type TermsAdminScreenProps = {
  view: AdminTermsView;
  createAction: FormAction;
};

export function TermsAdminScreen({ view, createAction }: TermsAdminScreenProps) {
  return (
    <main className="mx-auto w-full max-w-3xl p-8">
      <h1 className="text-xl font-bold">약관 관리</h1>
      <p className="mt-2 text-sm text-gray-500">
        기존 버전은 수정할 수 없습니다(변경 이력 보존). 문구를 바꾸려면 같은 종류로 새 버전을 등록하세요 —
        등록 즉시 가장 최신 버전으로 채택됩니다. 개설강의별로 추가 약관을 지정하려면{" "}
        <Link href="/admin/course-offerings" className="underline">
          개설강의 관리
        </Link>
        에서 설정하세요.
      </p>

      <ActionForm action={createAction} className="mt-6 flex flex-col gap-2 rounded border p-4 text-sm">
        <h2 className="font-medium">새 버전 등록</h2>
        <NativeSelect name="type" required defaultValue="">
          <NativeSelectOption value="">약관 종류 선택</NativeSelectOption>
          {view.typeOptions.map((opt) => (
            <NativeSelectOption key={opt.value} value={opt.value}>
              {opt.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Input name="version" placeholder="버전 (예: SOFTWARE_LICENSE_USE_v2)" required />
        <Textarea name="content" placeholder="약관 전문" required rows={6} />
        <Textarea name="change_summary" placeholder="변경 사유 (어디가 어떻게 바뀌었는지 상세히 작성) - 필수" required rows={2} />
        <ActionFormError />
        <ActionFormSubmitButton variant="default" className="mt-2 self-start">
          등록
        </ActionFormSubmitButton>
      </ActionForm>

      <div className="mt-6 flex flex-col gap-4">
        {view.groups.map((group) => (
          <div key={group.type}>
            <h3 className="font-medium">
              {group.title} <span className="text-xs text-gray-400">({group.type})</span>
            </h3>
            <ul className="mt-1 flex flex-col gap-2">
              {group.versions.map((ver) => (
                <li key={ver.id} className="rounded border p-3 text-xs">
                  <p className="font-medium text-gray-700">
                    {ver.version} {ver.isCurrent && <span className="text-green-600">(현재 버전)</span>}
                    <span className="ml-2 text-gray-400">{ver.effectiveText}</span>
                  </p>
                  {ver.changeSummary && (
                    <p className="mt-2 border-l-2 border-blue-200 bg-blue-50/50 p-2 text-blue-800 whitespace-pre-wrap">
                      <span className="font-semibold block mb-1">변경 사유:</span>
                      {ver.changeSummary}
                    </p>
                  )}
                  <p className="mt-2 whitespace-pre-wrap text-gray-500">{ver.content}</p>
                </li>
              ))}
              {group.versions.length === 0 && (
                <li className="text-xs text-gray-400">등록된 버전이 없습니다.</li>
              )}
            </ul>
          </div>
        ))}
      </div>
    </main>
  );
}
