import { redirect } from "next/navigation";
import { getCurrentAuthUser } from "@/lib/supabase/identity";
import { runQuery } from "@/lib/commands/run-command";

const ERROR_MESSAGES: Record<string, string> = {
  missing_code: "인증 정보를 받지 못했습니다. 다시 시도해 주세요.",
  auth_failed: "인증에 실패했습니다. 다시 로그인해 주세요.",
  use_email_login: "이메일 링크로만 로그인할 수 있습니다.",
};

export type LoginView = {
  /** 화면 상단 오류 문구. 오류 쿼리가 없으면 null. */
  errorMessage: string | null;
  /** 로그인 링크를 보낸 이메일(발송 완료 상태). 없으면 입력 폼을 보인다. */
  sentEmail: string | null;
};

// 로그인 — 이메일 매직링크 한 번(2026-09-25 재설계). 비밀번호 없음. 이미 로그인돼 있으면 "/"로 보낸다(원본 page와 같은 순서·같은 동작).
export async function loadLogin(input: { error?: string; sent?: string }): Promise<LoginView> {
  return runQuery({ command: "LOGIN_VIEW" }, async () => {
    const { user } = await getCurrentAuthUser();
    if (user) {
      redirect("/");
    }
    return {
      errorMessage: input.error ? (ERROR_MESSAGES[input.error] ?? "로그인 중 오류가 발생했습니다.") : null,
      sentEmail: input.sent ? input.sent : null,
    };
  });
}
