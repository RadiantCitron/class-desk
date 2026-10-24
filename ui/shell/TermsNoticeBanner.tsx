import Link from "next/link";
import { AlertTriangleIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/shadcn/alert";

// 학생 화면 상단 "필수 약관 동의 필요" 배너. 레이아웃은 모양을 갖지 않으므로 여기 둔다(ui-layer.guard).
export function TermsNoticeBanner() {
  return (
    <div className="mb-6">
      <Alert variant="destructive" className="border-red-500/50 bg-red-50/50 text-red-900">
        <AlertTriangleIcon className="h-4 w-4 text-red-600" />
        <AlertTitle className="text-red-800 font-bold">필수 약관 동의 필요</AlertTitle>
        <AlertDescription className="mt-1 flex items-center justify-between text-red-700">
          <span>필수 약관에 동의하지 않아 수강 신청 및 결제가 제한됩니다.</span>
          <Link href="/student/welcome" className="font-semibold underline underline-offset-2 hover:text-red-900">
            지금 확인하기
          </Link>
        </AlertDescription>
      </Alert>
    </div>
  );
}
