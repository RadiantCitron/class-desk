import { DiscountRulesScreen } from "@/ui/screens/admin/discount-rules/DiscountRulesScreen";
import { loadAdminDiscountRules } from "@/ui/views/admin/discount-rules";
import { createDiscountRule, deleteDiscountRule } from "./actions";

export default async function AdminDiscountRulesPage() {
  const view = await loadAdminDiscountRules();
  return <DiscountRulesScreen view={view} createAction={createDiscountRule} deleteAction={deleteDiscountRule} />;
}
