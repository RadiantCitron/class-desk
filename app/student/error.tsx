"use client";

import { ErrorFallback } from "@/ui/shell/ErrorFallback";

// app/student/** 하위에서 나는 예상 못 한 실패를 받는다.
// cancelMyEnrollment/useEntitlement/startPayment/updateProfile은 계획상 ActionForm으로
// 전환하지 않았으므로(throw 유지) 실제로 이 화면을 받는 주된 경로다.
export default function StudentErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <ErrorFallback error={error} retry={retry} backHref="/student" backLabel="대시보드로" />;
}
