import { signOut } from "@/app/actions/auth";
import { StudentShell } from "@/ui/shell/StudentShell";
import { TermsNoticeBanner } from "@/ui/shell/TermsNoticeBanner";
import { loadGateBanner } from "@/ui/views/shared/gate-banner";
import { STUDENT_NAV } from "@/ui/views/shared/student-nav";
import { loadPendingTermsNotice } from "@/ui/views/student/welcome";

// 캐시된 페이지가 "껐는데 안 꺼짐"을 만들지 않도록 이 레이아웃 하위 전부를 동적 렌더링으로 고정한다.
export const dynamic = "force-dynamic";

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const gate = await loadGateBanner();
  const hasPendingTerms = await loadPendingTermsNotice();

  return (
    <StudentShell nav={STUDENT_NAV} gate={gate} signOutAction={signOut}>
      {hasPendingTerms && <TermsNoticeBanner />}
      {children}
    </StudentShell>
  );
}
