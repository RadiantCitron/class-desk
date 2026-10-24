import { StudentsScreen } from "@/ui/screens/admin/students/StudentsScreen";
import { loadAdminStudents } from "@/ui/views/admin/students";

export default async function AdminStudentsPage() {
  const view = await loadAdminStudents();
  return <StudentsScreen view={view} />;
}
