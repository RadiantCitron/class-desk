import { manualDrainOutbox } from "@/app/admin/system/actions";
import { CourseOfferingsScreen } from "@/ui/screens/admin/course-offerings/CourseOfferingsScreen";
import { loadAdminCourseOfferings } from "@/ui/views/admin/course-offerings";
import {
  cancelCourseOffering,
  completeCourseOfferingCancel,
  createCourseOffering,
  deleteCourseOffering,
  setCourseOfferingAutoApprove,
  toggleCourseOfferingStatus,
} from "./actions";

// 폐강 액션의 인라인 드레인(최대 50건)이 Vercel 기본 한도를 넘지 않게(Doc-2 §6).
export const maxDuration = 60;

export default async function AdminCourseOfferingsPage() {
  const view = await loadAdminCourseOfferings();
  return (
    <CourseOfferingsScreen
      view={view}
      createAction={createCourseOffering}
      autoApproveAction={setCourseOfferingAutoApprove}
      toggleAction={toggleCourseOfferingStatus}
      deleteAction={deleteCourseOffering}
      cancelAction={cancelCourseOffering}
      completeCancelAction={completeCourseOfferingCancel}
      drainAction={manualDrainOutbox}
    />
  );
}
