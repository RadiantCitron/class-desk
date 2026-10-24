import { StudentDetailScreen } from "@/ui/screens/admin/students/StudentDetailScreen";
import { loadAdminStudentDetail } from "@/ui/views/admin/student-detail";

export const dynamic = "force-dynamic";

export default async function AdminStudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await loadAdminStudentDetail(id);
  return <StudentDetailScreen view={view} />;
}
