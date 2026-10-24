import { OrdersScreen } from "@/ui/screens/admin/orders/OrdersScreen";
import { loadAdminOrders } from "@/ui/views/admin/orders";
import { approveOrder, rejectOrder, cancelOrderByAdmin } from "./actions";

export default async function AdminOrdersPage() {
  const view = await loadAdminOrders();
  return (
    <OrdersScreen view={view} approveAction={approveOrder} rejectAction={rejectOrder} cancelAction={cancelOrderByAdmin} />
  );
}
