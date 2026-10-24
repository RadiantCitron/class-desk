import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { one } from "@/lib/supabase/relations";
import { describeLines, type SessionLine } from "@/lib/shared/schedule-change";

export type ScheduleChangeNotified = { order_id: string; user_id: string; notice_event_id: string };

/**
 * 일정 변경 안내 메일. 앱 안 안내(학생 홈)가 정본이고 메일은 알림 보조다 — 폐강 안내(offering-cancelled.ts)와 같은 규칙:
 * **throw 금지**, 실패는 콘솔 + dead_letters(INTERNAL)에 남기고 일정 변경은 되돌리지 않는다.
 * 호출: changeSchedule 서버 액션 — apply_schedule_change 성공 뒤.
 */
export async function notifyScheduleChanged(input: {
  offeringId: string;
  reason: string;
  before: SessionLine[];
  after: SessionLine[];
  notified: ScheduleChangeNotified[];
}): Promise<void> {
  if (input.notified.length === 0) return;
  const admin = createAdminClient();

  let offeringLabel = "개설강의";
  try {
    const { data: offering } = await admin.from("course_offerings").select("label, courses(name)").eq("id", input.offeringId).maybeSingle();
    if (offering) {
      const label = offering.label ? ` (${offering.label})` : "";
      offeringLabel = `${one(offering.courses)?.name ?? ""}${label}`.trim() || offeringLabel;
    }
  } catch (err) {
    console.error("일정 변경 메일: 개설 조회 실패", err);
  }

  const userIds = [...new Set(input.notified.map((n) => n.user_id))];
  const { data: users, error: usersError } = await admin.from("users").select("id, email").in("id", userIds);
  if (usersError) {
    console.error("일정 변경 메일: 수강생 이메일 조회 실패", usersError.message);
    await insertInternalDlq(admin, { offering_id: input.offeringId, error: usersError.message, stage: "lookup_users" });
    return;
  }
  const emailByUser = new Map((users ?? []).map((u) => [u.id, u.email as string | null]));

  for (const userId of userIds) {
    const to = emailByUser.get(userId)?.trim();
    if (!to) {
      await insertInternalDlq(admin, { offering_id: input.offeringId, user_id: userId, error: "이메일 없음", stage: "missing_email" });
      continue;
    }
    const subject = `[class-desk] ${offeringLabel} 일정 변경 안내`;
    const text = [
      `신청하신 수업의 일정이 변경되었습니다.`,
      ``,
      `수업: ${offeringLabel}`,
      `변경 사유: ${input.reason}`,
      `이전 일정: ${describeLines(input.before)}`,
      `변경된 일정: ${describeLines(input.after)}`,
      ``,
      `일정이 바뀌었습니다. 변경된 일정이 어려우시다면 로그인 후 「내 수강」 화면에서 「이 변경으로 환불 신청」을 눌러 주세요.`,
      `환불 금액은 약관의 환불 기준에 따라 관리자가 확인한 뒤 안내드립니다(자동으로 환불되지 않습니다).`,
      ``,
      `중요 안내는 이 등록 이메일로 보내 드립니다. 수신함·스팸함을 확인해 주세요.`,
    ].join("\n");
    try {
      await sendEmail({ to, subject, text });

      // A-8: 발송 성공(SMTP 수락) 사실을 주문 사건 SCHEDULE_CHANGE_NOTICE_EMAILED 로 기록 (throw 금지)
      const userNotified = input.notified.filter((n) => n.user_id === userId);
      for (const item of userNotified) {
        try {
          const { error: rpcErr } = await admin.rpc("record_schedule_change_email_sent", {
            p_order_id: item.order_id,
            p_notice_event_id: item.notice_event_id,
          });
          if (rpcErr) {
            console.error("일정 변경 메일 발송 사실 기록 실패:", item.order_id, rpcErr.message);
            await insertInternalDlq(admin, {
              offering_id: input.offeringId,
              order_id: item.order_id,
              notice_event_id: item.notice_event_id,
              error: rpcErr.message,
              stage: "record_email_sent",
            });
          }
        } catch (recordErr) {
          console.error("일정 변경 메일 발송 사실 기록 예외:", item.order_id, recordErr);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("일정 변경 메일 발송 실패:", to, message);
      await insertInternalDlq(admin, { offering_id: input.offeringId, user_id: userId, to, error: message, stage: "send" });
    }
  }
}

async function insertInternalDlq(admin: ReturnType<typeof createAdminClient>, payload: Record<string, unknown>) {
  try {
    await admin.from("dead_letters").insert({
      source: "INTERNAL",
      payload,
      error_message: `일정 변경 안내 메일 실패: ${String(payload.error ?? "")}`,
    });
  } catch (err) {
    console.error("일정 변경 메일 DLQ 적재 실패:", err);
  }
}
