"use client";

import { useRouter } from "next/navigation";
import { ResultDialog } from "@/ui/forms/ResultDialog";

// 결제 실패 복귀 안내 팝업. "확인"으로만 닫히고, 닫으면 주소에서 `from=return`을 지워(= 한 번만 보이게) 새로고침·뒤로가기에서
// 같은 팝업이 다시 뜨지 않게 한다. 결제 이력과 다시 결제하기 버튼은 팝업 뒤 같은 페이지에 이미 있다.
export function PaymentFailureDialog({ orderId, message }: { orderId: string; message: string }) {
  const router = useRouter();
  return (
    <ResultDialog
      ok={false}
      message={message}
      onClose={() => router.replace(`/student/payment/${orderId}`)}
    />
  );
}
