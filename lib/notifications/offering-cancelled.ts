import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { one } from "@/lib/supabase/relations";

export type OfferingCancelAffected = {
  order_id: string;
  user_id: string;
  action: string;
};

/**
 * 폐강 영향 수강생에게 안내 메일.
 * 호출: cancelCourseOffering — RPC → 인라인 드레인 → 여기.
 * throw 금지. 실패는 console.error + dead_letters(INTERNAL).
 */
export async function notifyOfferingCancelled(input: {
  offeringId: string;
  reason: string;
  affected: OfferingCancelAffected[];
}): Promise<void> {
  if (input.affected.length === 0) return;

  const admin = createAdminClient();

  let offeringLabel = "개설강의";
  try {
    const { data: offering } = await admin
      .from("course_offerings")
      .select("label, courses(name)")
      .eq("id", input.offeringId)
      .maybeSingle();
    if (offering) {
      const courseName = one(offering.courses)?.name ?? "";
      const label = offering.label ? ` (${offering.label})` : "";
      offeringLabel = `${courseName}${label}`.trim() || offeringLabel;
    }
  } catch (err) {
    console.error("폐강 메일: 개설 조회 실패", err);
  }

  const uniqueUserIds = [...new Set(input.affected.map((a) => a.user_id))];
  const { data: users, error: usersError } = await admin
    .from("users")
    .select("id, email")
    .in("id", uniqueUserIds);
  if (usersError) {
    console.error("폐강 메일: 수강생 이메일 조회 실패", usersError.message);
    await insertInternalDlq(admin, {
      offering_id: input.offeringId,
      error: usersError.message,
      stage: "lookup_users",
    });
    return;
  }

  const emailByUser = new Map((users ?? []).map((u) => [u.id, u.email as string | null]));

  for (const userId of uniqueUserIds) {
    const to = emailByUser.get(userId)?.trim();
    if (!to) {
      console.error("폐강 메일: 이메일 없음", userId);
      await insertInternalDlq(admin, {
        offering_id: input.offeringId,
        user_id: userId,
        error: "이메일 없음",
        stage: "missing_email",
      });
      continue;
    }

    const subject = `[class-desk] ${offeringLabel} 폐강 안내`;
    const text = [
      `신청하신 강의가 폐강되었습니다.`,
      ``,
      `강의: ${offeringLabel}`,
      `사유: ${input.reason}`,
      ``,
      `결제하셨거나 수강권을 받으신 경우, 환불·정리는 담당자가 개별로 처리하고 안내해 드립니다(자동으로 환불되지 않습니다).`,
      `미결제 신청은 정리되었습니다.`,
      ``,
      `자세한 상태는 로그인 후 「내 정보」에서 확인해 주세요.`,
      `중요 안내는 이 등록 이메일로 보내 드립니다. 수신함·스팸함을 확인해 주세요.`,
    ].join("\n");

    try {
      await sendEmail({ to, subject, text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("폐강 메일 발송 실패:", to, message);
      await insertInternalDlq(admin, {
        offering_id: input.offeringId,
        user_id: userId,
        to,
        error: message,
        stage: "send",
      });
    }
  }
}

async function insertInternalDlq(
  admin: ReturnType<typeof createAdminClient>,
  payload: Record<string, unknown>,
) {
  try {
    await admin.from("dead_letters").insert({
      source: "INTERNAL",
      payload,
      error_message: `폐강 안내 메일 실패: ${String(payload.error ?? "")}`,
    });
  } catch (err) {
    console.error("폐강 메일 DLQ 적재 실패:", err);
  }
}
