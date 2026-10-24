import { DlqScreen } from "@/ui/screens/admin/dlq/DlqScreen";
import { loadAdminDlq } from "@/ui/views/admin/dlq";
import { resolveDeadLetter, retryDeadOutboxMessage } from "./actions";

export default async function AdminDlqPage() {
  const view = await loadAdminDlq();
  return <DlqScreen view={view} resolveAction={resolveDeadLetter} retryAction={retryDeadOutboxMessage} />;
}
