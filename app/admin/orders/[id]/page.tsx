import { OrderDetailScreen } from "@/ui/screens/admin/orders/OrderDetailScreen";
import { getRefundableAmount } from "@/lib/payment";
import { loadAdminOrderDetail } from "@/ui/views/admin/order-detail";
import { closeOrderWithoutRefund, decideNoRefund, grantOrderAccess } from "../actions";
import { confirmManualRefund, confirmPaymentManually, markOrderRefundRequestFailed, rejectOrderRefundRequest, requestOrderRefund } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // getRefundableAmount는 결제 파사드의 export라 ui/views가 import할 수 없다(facade-boundary.guard F-16) — 여기서는 함수를 넘기기만 하고 호출은 Loader가 ADMIN일 때만 한다.
  // 이 한 곳만의 예외. 되돌리는 법은 ui/views/admin/order-detail.ts 주석 참고.
  const view = await loadAdminOrderDetail(id, { getRefundableAmount });
  return (
    <OrderDetailScreen
      view={view}
      confirmPaymentAction={confirmPaymentManually}
      grantAccessAction={grantOrderAccess}
      closeWithoutRefundAction={closeOrderWithoutRefund}
      refundAction={requestOrderRefund}
      markFailedAction={markOrderRefundRequestFailed}
      manualRefundAction={confirmManualRefund}
      rejectRefundRequestAction={rejectOrderRefundRequest}
      decideNoRefundAction={decideNoRefund}
    />
  );
}
