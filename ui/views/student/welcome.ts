import { runQuery } from "@/lib/commands/run-command";
import { TERMS_TYPE_LABELS } from "@/lib/terms";

// 개정 약관 재동의 화면(/student/welcome)과 학생 레이아웃의 "필수 약관 동의 필요" 배너가 읽는 값.
// 화면(ui/screens)은 lib를 직접 import하지 않고 이 Loader가 만든 값만 받는다(ui-layer.guard).
export type WelcomeTermView = {
  type: string;
  label: string;
  changeSummary: string | null;
  content: string;
};

export type WelcomeView = { terms: WelcomeTermView[] };

export async function loadWelcomeView(): Promise<WelcomeView> {
  return runQuery({ command: "STUDENT_WELCOME_VIEW" }, async (profile) => ({
    terms: (profile.pendingTerms ?? []).map((term) => ({
      type: term.type,
      label: TERMS_TYPE_LABELS[term.type] ?? term.type,
      changeSummary: term.change_summary,
      content: term.content,
    })),
  }));
}

// 학생 레이아웃 배너 표시 여부 — 동의할 필수 약관이 남아 있는가. 레이아웃은 모든 학생 화면을 감싸므로 이 안내 조회가 통제로 막혀도
// 배너만 빠지고 화면은 열린다(명령 레일 CR-5 — 관리자 틀의 건수 조회와 같은 이유).
export async function loadPendingTermsNotice(): Promise<boolean> {
  return runQuery({ command: "TERMS_NOTICE_VIEW", onDenied: () => false }, async (profile) => (profile.pendingTerms?.length ?? 0) > 0);
}
