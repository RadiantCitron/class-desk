import { createClient } from "@/lib/supabase/server";
import { runQuery } from "@/lib/commands/run-command";
import { TERMS_TYPE_LABELS } from "@/lib/terms";

export type AdminTermsView = {
  typeOptions: { value: string; label: string }[];
  groups: {
    type: string;
    title: string;
    versions: { id: string; version: string; isCurrent: boolean; effectiveText: string; content: string; changeSummary: string | null }[];
  }[];
};

const ALL_TYPES = Object.keys(TERMS_TYPE_LABELS);

// 약관 원문 관리 — 기존 버전은 수정하지 않고 "새 버전 등록"만 가능하다(append-only). ADMIN 전용(2026-09-18).
export async function loadAdminTerms(): Promise<AdminTermsView> {
  return runQuery({ command: "ADMIN_TERMS_VIEW" }, async () => {
    const supabase = await createClient();
    const { data: terms } = await supabase
      .from("terms")
      .select("id, type, version, content, effective_at, change_summary")
      .order("type")
      .order("effective_at", { ascending: false });

    return {
      typeOptions: ALL_TYPES.map((type) => ({ value: type, label: `${TERMS_TYPE_LABELS[type]} (${type})` })),
      groups: ALL_TYPES.map((type) => ({
        type,
        title: TERMS_TYPE_LABELS[type],
        versions: (terms?.filter((t) => t.type === type) ?? []).map((t, i) => ({
          id: t.id,
          version: t.version,
          isCurrent: i === 0,
          effectiveText: new Date(t.effective_at).toLocaleString("ko-KR"),
          content: t.content,
          changeSummary: t.change_summary,
        })),
      })),
    };
  });
}
