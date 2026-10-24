import { StudentHomeScreen } from "@/ui/screens/student/StudentHomeScreen";
import { loadStudentHome } from "@/ui/views/student/home";
import { cancelMyEnrollment, requestMyRefund } from "./actions";

export default async function StudentPage({ searchParams }: { searchParams: Promise<{ paid?: string }> }) {
  const view = await loadStudentHome(await searchParams);
  return <StudentHomeScreen view={view} cancelAction={cancelMyEnrollment} requestRefundAction={requestMyRefund} />;
}
