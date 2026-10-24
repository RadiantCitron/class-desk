import { CoursesScreen } from "@/ui/screens/admin/courses/CoursesScreen";
import { loadAdminCourses } from "@/ui/views/admin/courses";
import { createCourse, deleteCourse } from "./actions";

export default async function AdminCoursesPage() {
  const view = await loadAdminCourses();
  return <CoursesScreen view={view} createAction={createCourse} deleteAction={deleteCourse} />;
}
