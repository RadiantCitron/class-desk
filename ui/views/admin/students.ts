import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/supabase/relations";
import { runQuery } from "@/lib/commands/run-command";

export type AdminStudentRowView = {
  id: string;
  href: string;
  email: string;
  discordId: string;
  name: string;
  phone: string;
  joinedText: string;
  withdrawn: boolean;
  /** ADMIN만 보이는 "제한 N" 배지 값 — 이 학생에게 켜져 있는 스위치 수(0이면 "-"). */
  restrictionCount: number;
};

export type AdminStudentsView = { isAdmin: boolean; columnCount: number; rows: AdminStudentRowView[] };

// 새 화면(2026-09-18). VIEW_STUDENTS 또는 APPROVE_ORDERS 권한이 있으면 들어올 수 있다(신청 승인만 하는 매니저도 신청 전 학생 정보를 봐야 하므로).
export async function loadAdminStudents(): Promise<AdminStudentsView> {
  return runQuery({ command: "ADMIN_STUDENTS_VIEW" }, async (profile) => {

    const supabase = await createClient();
    // discord_id는 2026-09-27부터 users가 아니라 discord_accounts(이용권 모듈)에서 온다.
    const { data: students } = await supabase
      .from("users")
      .select("id, email, name, phone, created_at, withdrawn_at, discord_accounts(discord_id)")
      .eq("role", "STUDENT")
      .order("created_at", { ascending: false });

    // 켜져 있는 통제 스위치 수(그 학생 대상 행). RLS는 is_admin()만 타인 행을 볼 수 있다 — 매니저에게는 항상 빈 목록이 와서
    // "제한 0"으로 오해를 줄 수 있으므로, 컬럼 자체를 ADMIN에게만 보여준다(상세 페이지의 감사로그/스위치 섹션과 같은 원칙).
    const isAdmin = profile.role === "ADMIN";
    const restrictionCountByStudent = new Map<string, number>();
    if (isAdmin) {
      const { data: switchRows } = await supabase
        .from("rail_switches")
        .select("user_id")
        .not("user_id", "is", null)
        .is("cleared_at", null);
      for (const row of switchRows ?? []) {
        restrictionCountByStudent.set(row.user_id!, (restrictionCountByStudent.get(row.user_id!) ?? 0) + 1);
      }
    }

    return {
      isAdmin,
      columnCount: isAdmin ? 7 : 6,
      rows: (students ?? []).map((student) => ({
        id: student.id,
        href: `/admin/students/${student.id}`,
        email: student.email,
        discordId: one(student.discord_accounts)?.discord_id ?? "-",
        name: student.name ?? "-",
        phone: student.phone ?? "-",
        joinedText: new Date(student.created_at).toLocaleDateString("ko-KR"),
        withdrawn: !!student.withdrawn_at,
        restrictionCount: restrictionCountByStudent.get(student.id) ?? 0,
      })),
    };
  });
}
