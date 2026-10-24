import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 디스코드 연결 실패를 account_events에 append.
 * callback은 이 함수만 부른다 — raw INSERT·ENTRY에서 MEMBER RPC 직접 호출 금지(R6).
 */
export async function recordIdentityLinkFailed(
  userId: string,
  code: string,
  message?: string,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const detail: Record<string, string> = { code };
    if (message) detail.message = message;
    const { error } = await admin.rpc("record_identity_link_failed", {
      p_user_id: userId,
      p_detail: detail,
    });
    if (error) {
      console.error("IDENTITY_LINK_FAILED 기록 실패:", error.message);
    }
  } catch (err) {
    console.error("IDENTITY_LINK_FAILED 기록 예외:", err);
  }
}
