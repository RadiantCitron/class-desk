import { ApplyScreen } from "@/ui/screens/student/ApplyScreen";
import { loadApply } from "@/ui/views/student/apply";
import { applyForOffering } from "./actions";

export default async function ApplyPage({ params }: { params: Promise<{ offeringId: string }> }) {
  const { offeringId } = await params;
  const view = await loadApply(offeringId);
  return <ApplyScreen view={view} applyAction={applyForOffering} />;
}
