import { CourseOfferingDetailScreen } from "@/ui/screens/admin/course-offerings/CourseOfferingDetailScreen";
import { loadAdminCourseOfferingDetail } from "@/ui/views/admin/course-offering-detail";
import {
  cancelCourseOffering,
  completeCourseOfferingCancel,
  revokeOfferingCancel,
  deleteCourseOffering,
  endCourseOffering,
  cancelCourseOfferingEnd,
  toggleCourseOfferingStatus,
  updateCourseOffering,
  setCourseOfferingNotice,
} from "../actions";
import { addCourseSession, cancelCourseSession, changeSchedule, correctPastSession } from "./session-actions";
import { excludeOrderForScheduleChange } from "@/app/admin/orders/[id]/actions";
import { bulkCloseOrders } from "@/app/admin/orders/actions";
import { previewBulkRefund, executeBulkRefund } from "./refund-actions";

export const dynamic = "force-dynamic";
// 폐강 액션의 인라인 드레인(최대 50건)이 Vercel 기본 한도를 넘지 않게(목록 페이지와 같은 이유).
export const maxDuration = 60;

export default async function AdminCourseOfferingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await loadAdminCourseOfferingDetail(id);
  return (
    <CourseOfferingDetailScreen
      view={view}
      updateAction={updateCourseOffering}
      toggleAction={toggleCourseOfferingStatus}
      deleteAction={deleteCourseOffering}
      cancelAction={cancelCourseOffering}
      completeCancelAction={completeCourseOfferingCancel}
      revokeCancelAction={revokeOfferingCancel}
      endAction={endCourseOffering}
      cancelEndAction={cancelCourseOfferingEnd}
      addSessionAction={addCourseSession}
      cancelSessionAction={cancelCourseSession}
      correctSessionAction={correctPastSession}
      noticeAction={setCourseOfferingNotice}
      changeScheduleAction={changeSchedule}
      excludeScheduleChangeAction={excludeOrderForScheduleChange}
      previewBulkRefundAction={previewBulkRefund.bind(null, id)}
      executeBulkRefundAction={executeBulkRefund.bind(null, id)}
      bulkCloseAction={bulkCloseOrders}
    />
  );
}
