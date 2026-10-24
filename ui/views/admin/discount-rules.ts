import { createClient } from "@/lib/supabase/server";
import { runQuery } from "@/lib/commands/run-command";

export type AdminDiscountRulesView = {
  rules: { id: string; name: string; description: string | null; discountText: string; periodText: string }[];
};

// 수강료 산정기준(할인) 관리 — 기존엔 DB 테이블/RLS만 있고 화면이 없어 Studio/SQL로 직접 등록해야 했다. ADMIN 전용(2026-09-18).
export async function loadAdminDiscountRules(): Promise<AdminDiscountRulesView> {
  return runQuery({ command: "ADMIN_DISCOUNT_RULES_VIEW" }, async () => {
    const supabase = await createClient();
    const { data: rules } = await supabase
      .from("discount_rules")
      .select("id, name, discount_type, discount_value, description, valid_from, valid_until")
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    return {
      rules: (rules ?? []).map((rule) => ({
        id: rule.id,
        name: rule.name,
        description: rule.description || null,
        discountText:
          rule.discount_type === "PERCENT" ? `${rule.discount_value}%` : `${rule.discount_value.toLocaleString()}원`,
        periodText: `${rule.valid_from ?? "-"} ~ ${rule.valid_until ?? "-"}`,
      })),
    };
  });
}
