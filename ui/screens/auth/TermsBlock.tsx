import { ScrollArea } from "@/ui/shadcn/scroll-area";
import { checkboxClass } from "@/ui/forms/controls";

// 약관 제목 + 전문(높이 제한 스크롤) + 동의 체크박스. 체크박스는 네이티브 <input type="checkbox">다(e2e `input[type="checkbox"]`·FormData — 부록 A G9).
// name을 주면 FormData에 실린다(선택 동의용). 제목·라벨 문구는 호출하는 쪽이 현행 그대로 넘긴다.
export function TermsBlock({
  title,
  content,
  checkboxLabel,
  name,
  required = true,
}: {
  title: string;
  content: string;
  checkboxLabel: string;
  name?: string;
  required?: boolean;
}) {
  return (
    <div className="rounded border p-3 text-sm text-gray-700">
      <p className="font-medium text-gray-800">{title}</p>
      <ScrollArea className="mt-2 max-h-60 overflow-y-auto">
        <div className="whitespace-pre-wrap text-xs">{content}</div>
      </ScrollArea>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" name={name} required={required} className={checkboxClass} /> {checkboxLabel}
      </label>
    </div>
  );
}
