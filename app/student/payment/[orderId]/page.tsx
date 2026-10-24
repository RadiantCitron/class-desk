import { StudentPaymentScreen } from "@/ui/screens/student/StudentPaymentScreen";
import { loadStudentPayment } from "@/ui/views/student/payment";
import TossPayment from "./TossPayment";
import { failureNotice } from "./failure-message";
import { parseReturnResult, RETURN_NOTICES } from "./return-result";

export default async function PaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ from?: string; r?: string }>;
}) {
  const { orderId } = await params;
  const { from, r } = await searchParams;

  const view = await loadStudentPayment(orderId, {
    returnResult: from === "return" ? parseReturnResult(r) : null,
    returnNotices: RETURN_NOTICES,
    failureMessageFor: (code) => failureNotice(code).message,
  });
  const widget = view.unpaid?.widget ?? null;

  return (
    <StudentPaymentScreen
      view={view}
      paymentWidget={
        widget ? <TossPayment orderId={view.orderId} amount={widget.amount} orderName={widget.orderName} /> : null
      }
    />
  );
}
