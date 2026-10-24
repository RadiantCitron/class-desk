"use client";

import { useEffect } from "react";
import { Button } from "@/ui/shadcn/button";

// error.tsx 3개(app/, app/student/, app/admin/)가 공유하는 화면. 이 컴포넌트가 실제로
// 받는 것은 "예상 못 한 실패"뿐이다 — "예상된 실패"는 이미 lib/errors.ts의 runAction()이
// 액션 경계에서 가로채 ActionForm으로 보낸다.
//
// error.message를 화면에 보여주지 않는다 — Next.js 16이 프로덕션에서 서버발 에러 메시지를
// "일반 메시지 + digest"로 마스킹하므로(node_modules/next/dist/docs/01-app/03-api-reference/
// 03-file-conventions/error.md:106-111), 여기서 그 값을 꺼내 봐야 항상 의미 없는 문자열이다.
// 대신 사람이 "무슨 화면에서 무슨 일이 있었는지" CS 문의로 알려줄 수 있게 digest만 보여준다.
export function ErrorFallback({
  error,
  retry,
  backHref,
  backLabel,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  backHref: string;
  backLabel: string;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-xl font-bold">문제가 생겼습니다</h1>
      <p className="mt-3 text-sm text-gray-600">
        일시적인 오류일 수 있습니다. 다시 시도해 보시고, 계속되면 화면을 캡처해 관리자에게
        문의해 주세요.
        {error.digest && (
          <>
            {" "}
            (오류 코드: <span className="font-mono">{error.digest}</span>)
          </>
        )}
      </p>
      <div className="mt-6 flex gap-2">
        <Button type="button" onClick={() => retry()}>
          다시 시도
        </Button>
        <Button asChild variant="outline">
          <a href={backHref}>{backLabel}</a>
        </Button>
      </div>
    </main>
  );
}
