"use client";

import { ErrorFallback } from "@/ui/shell/ErrorFallback";

// 서버 액션 4개(cancelMyEnrollment/useEntitlement/startPayment/updateProfile)를 포함해,
// ActionForm으로 계약을 맺지 않은 모든 예상 못 한 실패가 여기로 온다.
// app/student·app/admin이 더 구체적인 안내를 따로 두므로, 여기는 그 둘 밖의
// 나머지(로그인·약관 화면 등)를 받는 최종 안전망이다.
export default function GlobalErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <ErrorFallback error={error} retry={retry} backHref="/" backLabel="처음으로" />;
}
