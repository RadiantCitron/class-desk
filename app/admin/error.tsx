"use client";

import { ErrorFallback } from "@/ui/shell/ErrorFallback";

// app/admin/** 하위(관리자·매니저 화면)를 받는다.
// 관리자 액션은 ActionForm으로 전환하지 않았으므로(관리자는 본인이라 학생보다
// 우선순위가 낮다고 판단), 관리자 액션
// 15개가 실제로 이 화면을 받는다.
export default function AdminErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <ErrorFallback error={error} retry={retry} backHref="/admin" backLabel="관리자 홈으로" />;
}
