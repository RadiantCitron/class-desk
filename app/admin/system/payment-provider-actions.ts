"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { runCommand } from "@/lib/commands/run-command";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";

const providerLabel = (p: string | null) => (p === null ? "미설정(결제 차단)" : p);

// PG-8: setGate(CS)와 같은 파일에 두면 ENTRY-MULTI-WRITE(R6)이므로 PAYMENT 쓰기만 여기 둔다.
// R-6(2026-10-02): 성공하면 "무엇에서 무엇으로 바뀌었는지"를 문장으로 돌려줘 화면의 결과 팝업이 보여 준다.
// 현재 값과 같은 값으로 바꾸려는 요청은 거부한다(2026-10-02에 PAYAPP→PAYAPP 재설정이 감사 로그에 남은 사례).
export async function setPaymentProvider(
  provider: string | null,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    // 페이앱 폐기(2026-10-02): 허용 목록에서 PAYAPP을 뺐다(DB set_payment_provider·CHECK와 같은 목록). 새 PG는 둘 다에 추가.
    if (provider !== null && provider !== "TOSS") {
      throw new UserFacingError(`알 수 없는 결제 제공자: ${provider}`);
    }
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) throw new UserFacingError("변경 사유를 입력해 주세요.");

    const message = await runCommand({ command: "PAYMENT_PROVIDER_SET", targetTable: "payment_settings" }, async (adminProfile) => {
      const admin = createAdminClient();
      const { data: before } = await admin
        .from("payment_settings")
        .select("active_provider")
        .eq("id", "SINGLETON")
        .maybeSingle();
      const previous = (before?.active_provider ?? null) as string | null;
      if (previous === provider) {
        throw new UserFacingError(`이미 ${providerLabel(provider)}입니다. 바꿀 내용이 없습니다.`);
      }

      const { error } = await admin.rpc("set_payment_provider", {
        p_active_provider: provider,
        p_reason: reason,
        p_actor_id: adminProfile.id,
      });
      if (error) throw new Error(`PG 설정 변경 실패: ${error.message}`);
      return {
        result: `결제 PG를 ${providerLabel(previous)} → ${providerLabel(provider)}(으)로 변경했습니다.\n사유: ${reason}`,
        targetId: null,
        detail: { provider, previous, reason },
      };
    });

    revalidatePath("/admin/system");
    return message;
  });
}
