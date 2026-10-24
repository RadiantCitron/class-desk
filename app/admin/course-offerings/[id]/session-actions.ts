"use server";

import { revalidatePath } from "next/cache";
import { runCommand } from "@/lib/commands/run-command";
import { createAdminClient } from "@/lib/supabase/admin";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";
import { parseSessionRows } from "@/lib/orders/session-rows";
import { loadActiveSessions } from "@/lib/orders/schedule-change";
import { notifyScheduleChanged, type ScheduleChangeNotified } from "@/lib/notifications/schedule-changed";
import { diffSessions } from "@/lib/shared/schedule-change";

// 개설 후 회차 추가·취소. 허용 조건(개강 전, 살아 있는 신청 없음, 사유 필수 등)은 DB 함수가 직접 판정하고
// 이 파일은 입력을 받아 명령으로 감싸는 얇은 층이다(R6: 서버 액션 1개 = 명령 1개). 시각·날짜 변경 = 취소 + 추가.

function revalidateOffering(offeringId: string) {
  revalidatePath("/admin/course-offerings");
  revalidatePath(`/admin/course-offerings/${offeringId}`);
}

// DB가 사용자에게 보여도 되는 한국어 문구로 거부한 것은 그대로, 겹침 제약 위반만 알아보기 쉬운 문구로 바꾼다.
function friendly(message: string): string {
  if (message.includes("course_sessions_no_overlap_active")) {
    return "같은 날짜·시간대에 이미 다른 회차(다른 수업 포함)가 있어 추가할 수 없습니다.";
  }
  return message;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function addCourseSession(
  offeringId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const str = (key: string) => String(formData.get(key) ?? "").trim();
    const date = str("date");
    const start = str("start");
    const end = str("end");
    const reason = str("reason");
    if (!DATE_RE.test(date)) throw new UserFacingError("날짜를 입력해 주세요.");
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw new UserFacingError("시작·종료 시각을 입력해 주세요.");
    if (start >= end) throw new UserFacingError("종료 시각은 시작 시각보다 늦어야 합니다.");
    if (!reason) throw new UserFacingError("추가 사유를 입력해 주세요.");

    await runCommand({ command: "COURSE_SESSION_ADD", targetTable: "course_sessions", target: { targetId: offeringId } }, async (adminProfile) => {
      const admin = createAdminClient();
      const { data, error } = await admin.rpc("add_course_session", {
        p_offering_id: offeringId,
        p_actor: adminProfile.id,
        p_actor_role: adminProfile.role,
        p_reason: reason,
        p_date: date,
        p_start: start,
        p_end: end,
      });
      if (error) throw new UserFacingError(friendly(error.message));
      return { result: null, targetId: offeringId, detail: { sessionId: data, date, start, end, reason } };
    });

    revalidateOffering(offeringId);
    return `${date} ${start}~${end} 회차를 추가했습니다. 개강·종료가 다시 계산됩니다.`;
  });
}

export async function cancelCourseSession(
  offeringId: string,
  sessionId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) throw new UserFacingError("취소 사유를 입력해 주세요.");

    await runCommand({ command: "COURSE_SESSION_CANCEL", targetTable: "course_sessions", target: { targetId: sessionId } }, async (adminProfile) => {
      const admin = createAdminClient();
      const { error } = await admin.rpc("cancel_course_session", {
        p_session_id: sessionId,
        p_actor: adminProfile.id,
        p_actor_role: adminProfile.role,
        p_reason: reason,
      });
      if (error) throw new UserFacingError(friendly(error.message));
      return { result: null, targetId: sessionId, detail: { offeringId, reason } };
    });

    revalidateOffering(offeringId);
    return "회차를 취소했습니다(기록은 비활성으로 남습니다). 개강·종료가 다시 계산됩니다.";
  });
}

/**
 * 지난 회차 기록 정정(ADR-0029 E1~E7).
 * 이미 시작된 회차의 날짜·시각 기록을 정정한다(취소 + 추가). 시작 전 회차는 일정 변경으로 가야 한다.
 * 수강생 안내는 하지 않으며 개설강의 원장에 SESSION_CORRECTED 사건을 기록한다.
 */
export async function correctPastSession(
  offeringId: string,
  sessionId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const str = (key: string) => String(formData.get(key) ?? "").trim();
    const date = str("date");
    const start = str("start");
    const end = str("end");
    const reason = str("reason");
    if (!DATE_RE.test(date)) throw new UserFacingError("날짜를 입력해 주세요.");
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw new UserFacingError("시작·종료 시각을 입력해 주세요.");
    if (start >= end) throw new UserFacingError("종료 시각은 시작 시각보다 늦어야 합니다.");
    if (!reason) throw new UserFacingError("정정 사유를 입력해 주세요.");

    await runCommand(
      { command: "COURSE_SESSION_CORRECT", targetTable: "course_sessions", target: { targetId: sessionId } },
      async (adminProfile) => {
        const admin = createAdminClient();
        const { data, error } = await admin.rpc("correct_past_session", {
          p_session_id: sessionId,
          p_date: date,
          p_start: start,
          p_end: end,
          p_actor_id: adminProfile.id,
          p_actor_role: adminProfile.role,
          p_reason: reason,
        });
        if (error) throw new UserFacingError(friendly(error.message));
        return { result: null, targetId: sessionId, detail: { offeringId, newSessionId: data, date, start, end, reason } };
      },
    );

    revalidateOffering(offeringId);
    return `${date} ${start}~${end} 회차로 기록을 정정했습니다(수업한 사실을 바로잡았으며 수강생에게 알리지 않습니다).`;
  });
}

/**
 * 일정 변경(수강생 안내 포함) — 관리자가 달력(SessionPicker)에서 만든 **원하는 전체 일정**을 보내면 현재 활성 회차와 비교해
 * 취소할 회차·추가할 회차를 계산하고(시각만 바꾼 날짜는 취소 + 추가), DB 함수 apply_schedule_change가 한 트랜잭션으로 적용하며 살아 있는 주문마다 안내 사건을 남긴다.
 * 개강 전에 한해 허용된다(DB가 판정). 안내 메일은 알림 보조로, 실패해도 변경을 되돌리지 않는다.
 */
export async function changeSchedule(
  offeringId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) throw new UserFacingError("변경 사유를 입력해 주세요.");
    const locationRaw = formData.get("location");
    const nextLocation = typeof locationRaw === "string" ? locationRaw.trim() || null : null;
    let desired;
    try {
      desired = parseSessionRows(String(formData.get("sessions") ?? ""));
    } catch (err) {
      throw new UserFacingError(err instanceof Error ? err.message : "회차 입력이 올바르지 않습니다.");
    }

    const updateNotice = formData.get("update_notice") === "on";
    const rawNotice = formData.get("notice");
    const nextNotice = typeof rawNotice === "string" ? rawNotice.trim() || null : null;

    const summary = await runCommand(
      { command: "COURSE_SCHEDULE_CHANGE", targetTable: "course_sessions", target: { targetId: offeringId } },
      async (adminProfile) => {
        const current = await loadActiveSessions(offeringId);
        const { cancelIds, add } = diffSessions(current, desired);
        const admin = createAdminClient();
        const { data, error } = await admin.rpc("apply_schedule_change", {
          p_offering_id: offeringId,
          p_actor: adminProfile.id,
          p_actor_role: adminProfile.role,
          p_reason: reason,
          p_cancel_session_ids: cancelIds,
          p_add_sessions: add,
          p_location: nextLocation,
          p_notice: nextNotice,
          p_update_notice: updateNotice,
        });
        if (error) throw new UserFacingError(friendly(error.message));
        const result = data as { change_id: string; notified: ScheduleChangeNotified[] };
        return {
          result: { notified: result.notified ?? [], before: current.map(({ date, start, end }) => ({ date, start, end })) },
          targetId: offeringId,
          detail: { reason, changeId: result.change_id, cancelled: cancelIds.length, added: add.length, notified: (result.notified ?? []).length, location: nextLocation },
        };
      },
    );

    revalidateOffering(offeringId);
    await notifyScheduleChanged({ offeringId, reason, before: summary.before, after: desired, notified: summary.notified });
    const n = summary.notified.length;
    return n > 0
      ? `일정을 변경했습니다. 신청자 ${n}명에게 안내했습니다(앱 안 안내 + 이메일). 수강생이 응답하면 개설강의 상세의 「일정 변경 응답 현황」에 표시되고, 동의하지 않거나 응답이 없는 수강생은 직접 제외 처리해야 합니다.`
      : "일정을 변경했습니다(신청자가 없어 안내할 사람은 없습니다).";
  });
}
