import { PaymentsScreen } from "@/ui/screens/admin/payments/PaymentsScreen";
import { loadAdminPayments } from "@/ui/views/admin/payments";

export default async function AdminPaymentsPage() {
  const view = await loadAdminPayments();
  return <PaymentsScreen view={view} />;
}
