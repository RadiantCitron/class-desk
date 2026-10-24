import { createClient } from "@/lib/supabase/server";
import { runQuery } from "@/lib/commands/run-command";

export type AdminCoursesView = { courses: { id: string; name: string; category: string }[] };

// ADMIN 전용(2026-09-18). 매니저 권한 3종에 강의 관리는 포함되지 않는다 — proxy.ts도 막지만 페이지 자체에도 가드를 둔다.
export async function loadAdminCourses(): Promise<AdminCoursesView> {
  return runQuery({ command: "ADMIN_COURSES_VIEW" }, async () => {
    const supabase = await createClient();
    const { data: courses } = await supabase
      .from("courses")
      .select("id, name, category")
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    return { courses: (courses ?? []).map((c) => ({ id: c.id, name: c.name, category: c.category ?? "-" })) };
  });
}
