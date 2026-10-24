"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { runCommand } from "@/lib/commands/run-command";
import { runOutboxBatch } from "@/lib/wiring/outbox";
import { findOfferingCancelBlockers } from "@/lib/guards/offering-cancel-settled";
import { notifyOfferingCancelled } from "@/lib/notifications/offering-cancelled";
import { CONDITIONAL_TERMS_TYPES } from "@/lib/terms";
import { parseBlobPathname } from "@/lib/downloads/pathname";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";
import { formatKst, parseKstLocal } from "@/lib/shared/datetime";
import { parseSessionRows } from "@/lib/orders/session-rows";
import { normalizeOfferingNotice } from "@/lib/shared/offering-notice";
// 개설강의 목록과 상세 둘 다 갱신한다(상세 페이지에서도 같은 액션을 부른다 — U 단계 5).
function revalidateOffering(offeringId: string) {
  revalidatePath("/admin/course-offerings");
  revalidatePath(`/admin/course-offerings/${offeringId}`);
}

// 예상된 실패는 UserFacingError + runAction으로 감싼다.
export async function createCourseOffering(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const courseId = String(formData.get("course_id") ?? "");
    const label = String(formData.get("label") ?? "").trim() || null;
    const capacity = Number(formData.get("capacity"));
    const price = Number(formData.get("price"));
    const location = String(formData.get("location") ?? "").trim() || null;
    // 모집 시작 ~ 개강 전이 신청 기간이다. 개강·종료는 입력이 아니라 회차에서 계산된다 —
    // 폼의 달력(SessionPicker)이 고른 날짜별 회차 목록을 JSON 한 필드(sessions)로 보낸다. 요일 채우기·행별 시각은 화면의
    // 편의일 뿐 저장되는 것은 날짜 행뿐이고, 최종 검증은 여기(parseSessionRows)와 DB가 한다.
    const recruitOpensAt = String(formData.get("recruit_opens_at") ?? "");
    const sessionsRaw = String(formData.get("sessions") ?? "");
    // 디스코드에서 강의를 진행하는 경우, 결제 완료 시 이 역할을 자동 부여/회수한다
    // ("결제 확인한 사람만 정해진 방에 입장"). 비워두면 기존과 동일하게 COURSE_ACCESS만
    // 부여된다. 실제 서버/역할 준비 전이라도 미리 값만 넣어둘 수 있다(디스코드 API 호출은 나중에
    // 실제로 트리거될 때 실패해도 DLQ에 기록만 되고 다른 기능엔 영향 없음).
    // 온라인(디스코드) 수업 체크(R-8, 2026-10-02) — 체크하지 않으면 역할·채널 입력은 무시한다(폼도 보내지 않지만 서버가 다시 확인).
    const isOnline = formData.get("is_online") === "on";
    const discordRoleId = isOnline ? String(formData.get("discord_role_id") ?? "").trim() || null : null;
    // 방(채널) 정보 — 서버는 시스템 전체 1개뿐이라(DISCORD_GUILD_ID) 채널ID만 저장하고,
    // 딥링크는 화면에서 그 값과 조합해 만든다(2026-09-27). 역할과 달리 선택 항목이다.
    const discordChannelId = isOnline ? String(formData.get("discord_channel_id") ?? "").trim() || null : null;
    if (isOnline && !discordRoleId) {
      throw new UserFacingError("온라인(디스코드) 수업은 디스코드 역할 ID를 입력해야 합니다.");
    }
    const blobPathnameRaw = String(formData.get("blob_pathname") ?? "").trim();
    // 신청 시 자동 승인 — 개설강의마다 on/off. 결제는 별도.
    const autoApprove = formData.get("auto_approve") === "on";
    // 이 개설강의가 공통 약관(SERVICE_USE/PRIVACY_USE) 외에 추가로 요구하는 약관 — 과목에 따라
    // 다를 수 있다는 요구 반영(예: AI 활용 강의는 해외이전동의, 소스코드 결합 판매는 이용허락동의).
    const requiredTermsTypes = formData
      .getAll("required_terms_types")
      .map(String)
      .filter((type) => (CONDITIONAL_TERMS_TYPES as readonly string[]).includes(type));

    if (!courseId || !Number.isFinite(capacity) || !Number.isFinite(price) || !recruitOpensAt) {
      throw new UserFacingError("입력값이 올바르지 않습니다.");
    }

    // 업로드 UI는 없다. 버셀 홈페이지에서 올린 뒤 pathname만 적는다. 비우면 다운로드권 없음.
    const blobPathname = blobPathnameRaw ? parseBlobPathname(blobPathnameRaw) : null;
    const grants: Array<{
      type: "COURSE_ACCESS" | "DISCORD_ROLE" | "SOURCE_DOWNLOAD";
      discord_role_id?: string;
      discord_channel_id?: string;
      blob_pathname?: string;
      max_uses?: number;
    }> = [{ type: "COURSE_ACCESS" }];
    if (discordRoleId) {
      grants.push({
        type: "DISCORD_ROLE",
        discord_role_id: discordRoleId,
        ...(discordChannelId ? { discord_channel_id: discordChannelId } : {}),
      });
    }
    if (blobPathname) {
      grants.push({ type: "SOURCE_DOWNLOAD", blob_pathname: blobPathname, max_uses: 1 });
    }

    await runCommand({ command: "COURSE_OFFERING_CREATE", targetTable: "course_offerings" }, async (adminProfile) => {
      const admin = createAdminClient();
      // datetime-local은 한국 시간으로 해석한다(수정과 같은 규칙, lib/shared/datetime.ts — 서버 시간대에 따라
      // 9시간 어긋나던 잠재 문제를 막는다. 로컬 KST에서는 이전과 결과가 같다).
      let recruitOpensAtIso: string;
      try {
        recruitOpensAtIso = parseKstLocal(recruitOpensAt);
      } catch {
        throw new UserFacingError("모집 시작 시각 형식이 올바르지 않습니다.");
      }
      let sessions;
      try {
        sessions = parseSessionRows(sessionsRaw);
      } catch (err) {
        throw new UserFacingError(err instanceof Error ? err.message : "회차 입력이 올바르지 않습니다.");
      }

      // 개설강의 INSERT + 회차 INSERT를 하나의 DB 트랜잭션으로 묶는다(원자성 위험 유형 2
      // 해결, 2026-09-21). 회차 등록이 실패하면(겹치는 시간대 등)
      // Postgres가 방금 만든 개설강의까지 자동으로 롤백한다 — 예전처럼 실패 시 수동으로
      // delete하는 보상 코드가 필요 없다.
      const { data: offeringId, error } = await admin.rpc("create_course_offering", {
        p_course_id: courseId,
        p_label: label,
        p_capacity: capacity,
        p_price: price,
        p_location: location,
        p_required_terms_types: requiredTermsTypes,
        p_grants: grants,
        p_recruit_opens_at: recruitOpensAtIso,
        p_sessions: sessions,
        p_actor: adminProfile.id,
        p_actor_role: adminProfile.role,
        p_auto_approve: autoApprove,
      });

      if (error) {
        // 입력으로 일어날 수 있는 두 가지는 사용자용 문구로 보여 준다(달력에서 날짜를 고르다 겹치기 쉽다). 나머지는 예상 밖 오류라 그대로 던진다.
        if (error.message.includes("course_sessions_no_overlap_active")) {
          throw new UserFacingError("개설강의 생성 실패: 고른 날짜·시간대가 이미 있는 다른 수업의 회차와 겹칩니다. 날짜나 시각을 바꿔 주세요.");
        }
        if (error.message.includes("모집 시작은 개강")) {
          throw new UserFacingError("개설강의 생성 실패: 모집 시작은 첫 회차 시작보다 앞이어야 합니다.");
        }
        throw new Error(`개설강의 생성 실패: ${error.message}`);
      }

      return {
        result: null,
        targetId: offeringId,
        detail: {
          courseId,
          label,
          capacity,
          price,
          recruitOpensAt: recruitOpensAtIso,
          sessionCount: sessions.length,
          firstDate: sessions[0].date,
          lastDate: sessions[sessions.length - 1].date,
          requiredTermsTypes,
          discordRoleId,
          blobPathname,
          autoApprove,
        },
      };
    });

    revalidatePath("/admin/course-offerings");
  });
}

// 기존 개설강의의 신청 시 자동 승인 on/off. U 단계 6부터 개설강의 쓰기는
// update_course_offering 한 경로다(직접 .update 제거, 감사 액션명 COURSE_OFFERING_SET_AUTO_APPROVE →
// COURSE_OFFERING_UPDATE). 목록의 토글은 사유 입력이 없어 기본 사유를 채운다.
export async function setCourseOfferingAutoApprove(
  offeringId: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const autoApprove = formData.get("auto_approve") === "on";
    await runCommand({ command: "COURSE_OFFERING_UPDATE", targetTable: "course_offerings" }, async (adminProfile) => {
      const admin = createAdminClient();
      // 값이 같으면 예전처럼 아무 일도 없이 끝낸다(update_course_offering은 "변경된 값이 없습니다"로 거부한다).
      const { data: current } = await admin
        .from("course_offerings")
        .select("auto_approve")
        .eq("id", offeringId)
        .maybeSingle();
      if (current && current.auto_approve === autoApprove) {
        return { result: null, targetId: offeringId, detail: { auto_approve: autoApprove, noChange: true } };
      }
      const { data: changes, error } = await admin.rpc("update_course_offering", {
        p_offering_id: offeringId,
        p_actor: adminProfile.id,
        p_actor_role: adminProfile.role,
        p_reason: "자동승인 토글(목록)",
        p_patch: { auto_approve: autoApprove },
      });
      if (error) throw new UserFacingError(error.message);
      return { result: null, targetId: offeringId, detail: { reason: "자동승인 토글(목록)", changes } };
    });
    revalidateOffering(offeringId);
  });
}

// 개설강의 수정(U 단계 6). 폼은 바뀐 필드만 패치에 담는다(원래 값 orig_*와 비교) — 안 바꾼 필드를 오래된 값으로
// 덮어쓰지 않으려는 것이다. 실제 검증·정원 처리는 DB 함수(update_course_offering)가 한다.
const FIELD_LABELS: Record<string, string> = {
  label: "회차 라벨",
  location: "위치",
  recruit_opens_at: "모집 시작",
  required_terms_types: "추가 약관",
  discord_role_id: "디스코드 역할",
  discord_channel_id: "디스코드 채널",
  auto_approve: "자동승인",
  auto_refund: "자동환불",
  manual_end: "수동 종료",
  capacity: "정원",
  price: "가격",
};

function describeValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "없음";
  if (key === "recruit_opens_at") return formatKst(String(value));
  if (key === "auto_approve" || key === "auto_refund" || key === "manual_end") return value ? "켜짐" : "꺼짐";
  if (key === "price") return `${Number(value).toLocaleString()}원`;
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "없음";
  return String(value);
}

export async function updateCourseOffering(
  offeringId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const str = (key: string) => String(formData.get(key) ?? "").trim();
    // 수정 잠금(개강·마감) 때 화면은 핵심 칸을 disabled로 보내지 않는다 — 폼에 없는 칸은 "변경 없음"이다
    // (예전엔 빈 값으로 바뀐 것으로 보고 "시각을 입력해 주세요"로 막혀, 잠긴 강의의 라벨·디스코드도 못 고쳤다).
    const changed = (key: string) => formData.has(key) && str(key) !== str(`orig_${key}`);

    const reason = str("reason");
    if (!reason) throw new UserFacingError("수정 사유를 입력해 주세요.");

    const patch: Record<string, unknown> = {};
    if (changed("label")) patch.label = str("label") || null;
    if (changed("location")) patch.location = str("location") || null;
    try {
      if (changed("recruit_opens_at")) {
        if (!str("recruit_opens_at")) throw new UserFacingError("모집 시작 시각을 입력해 주세요.");
        patch.recruit_opens_at = parseKstLocal(str("recruit_opens_at"));
      }
    } catch (err) {
      if (err instanceof UserFacingError) throw err;
      throw new UserFacingError("모집 시작 시각 형식이 올바르지 않습니다.");
    }
    for (const key of ["capacity", "price"] as const) {
      if (!changed(key)) continue;
      const value = Number(str(key));
      if (str(key) === "" || !Number.isInteger(value)) {
        throw new UserFacingError(`${FIELD_LABELS[key]}은(는) 정수로 입력해 주세요.`);
      }
      patch[key] = value;
    }
    // 온라인(디스코드) 수업 체크(R-8): 풀면 역할·채널을 둘 다 비운다(DB 함수는 역할 없이 채널만 두는 것을 거부).
    const isOnline = formData.get("is_online") === "on";
    const nextRole = isOnline ? str("discord_role_id") : "";
    const nextChannel = isOnline ? str("discord_channel_id") : "";
    if (isOnline && !nextRole) {
      throw new UserFacingError("온라인(디스코드) 수업은 디스코드 역할 ID를 입력해야 합니다.");
    }
    if (nextRole !== str("orig_discord_role_id")) patch.discord_role_id = nextRole || null;
    if (nextChannel !== str("orig_discord_channel_id")) patch.discord_channel_id = nextChannel || null;
    const autoApprove = formData.get("auto_approve") === "on";
    if (autoApprove !== (str("orig_auto_approve") === "true")) patch.auto_approve = autoApprove;
    const autoRefund = formData.get("auto_refund") === "on";
    if (autoRefund !== (str("orig_auto_refund") === "true")) patch.auto_refund = autoRefund;
    const manualEnd = formData.get("manual_end") === "on";
    if (manualEnd !== (str("orig_manual_end") === "true")) patch.manual_end = manualEnd;
    const terms = formData
      .getAll("required_terms_types")
      .map(String)
      .filter((type) => (CONDITIONAL_TERMS_TYPES as readonly string[]).includes(type))
      .sort();
    if (terms.join(",") !== str("orig_required_terms_types")) patch.required_terms_types = terms;

    const reissueDiscord = formData.get("reissue_discord") === "on";

    if (Object.keys(patch).length === 0) throw new UserFacingError("변경된 값이 없습니다.");

    const changes = await runCommand({ command: "COURSE_OFFERING_UPDATE", targetTable: "course_offerings" }, async (adminProfile) => {
      const admin = createAdminClient();
      const { data, error } = await admin.rpc("update_course_offering", {
        p_offering_id: offeringId,
        p_actor: adminProfile.id,
        p_actor_role: adminProfile.role,
        p_reason: reason,
        p_patch: patch,
        p_reissue_discord: reissueDiscord,
      });
      if (error) throw new UserFacingError(error.message);
      return { result: (data ?? {}) as Record<string, { from: unknown; to: unknown }>, targetId: offeringId, detail: { reason, changes: data, reissueDiscord } };
    });

    if (reissueDiscord) {
      try {
        await runOutboxBatch();
      } catch (err) {
        console.error("디스코드 역할 재부여 아웃박스 드레인 실패(다음 드레인에서 재시도):", err);
      }
    }

    revalidateOffering(offeringId);
    const lines = Object.entries(changes).map(
      ([key, { from, to }]) => `${FIELD_LABELS[key] ?? key}: ${describeValue(key, from)} → ${describeValue(key, to)}`,
    );
    return ["개설강의를 수정했습니다.", ...lines].join("\n");
  });
}

// 개설강의 공지문 설정 — 텍스트 한 칸 전용 함수 set_course_offering_notice 호출.
export async function setCourseOfferingNotice(
  offeringId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const rawNotice = formData.get("notice");
    let notice: string | null;
    try {
      notice = normalizeOfferingNotice(typeof rawNotice === "string" ? rawNotice : null);
    } catch (err) {
      throw new UserFacingError(err instanceof Error ? err.message : "공지문 입력이 올바르지 않습니다.");
    }

    const reason = String(formData.get("reason") ?? "").trim() || (notice ? "공지문 수정" : "공지문 삭제");

    await runCommand({ command: "COURSE_OFFERING_NOTICE_SET", targetTable: "course_offerings" }, async (adminProfile) => {
      const admin = createAdminClient();
      const { error } = await admin.rpc("set_course_offering_notice", {
        p_offering_id: offeringId,
        p_actor: adminProfile.id,
        p_actor_role: adminProfile.role,
        p_notice: notice,
        p_reason: reason,
      });
      if (error) throw new UserFacingError(error.message);
      return { result: null, targetId: offeringId, detail: { notice, reason } };
    });

    revalidateOffering(offeringId);
    revalidatePath("/student");
    return notice ? "공지문을 저장했습니다." : "공지문을 삭제했습니다.";
  });
}


export async function toggleCourseOfferingStatus(
  offeringId: string,
  nextStatus: "OPEN" | "CLOSED",
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    // 마감(CLOSED)·재개(OPEN) 둘 다 사유가 필수다
    // ("관리자가 바꾸는 상태 전이는 방향과 무관하게 전부 사유 필수"). 예전엔 재개는 사유를
    // 비우는 패턴 B였다). 누가 언제 바꿨는지는 두 방향 다 남긴다.
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      throw new UserFacingError(
        nextStatus === "CLOSED" ? "마감 사유를 입력해 주세요." : "재개 사유를 입력해 주세요.",
      );
    }

    await runCommand({ command: "COURSE_OFFERING_STATUS_CHANGE", targetTable: "course_offerings" }, async (adminProfile) => {
      const admin = createAdminClient();
      const { error } = await admin.rpc("set_course_offering_status", {
        p_offering_id: offeringId,
        p_next_status: nextStatus,
        p_reason: reason,
        p_actor: adminProfile.id,
        p_actor_role: adminProfile.role,
      });

      if (error) {
        throw new UserFacingError(error.message);
      }

      return { result: null, targetId: offeringId, detail: { nextStatus, reason } };
    });

    revalidateOffering(offeringId);
  });
}

// 실제로는 지우지 않고 deleted_at만 세팅한다(courses/actions.ts와 동일한 원칙, 2026-09-11 확정).
// 신청 내역(enrollments)이 하나라도 있으면 막는다 — 기존 ON DELETE RESTRICT와 동일한 조건.
export async function deleteCourseOffering(
  offeringId: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      throw new UserFacingError("삭제 사유를 입력해 주세요.");
    }

    await runCommand({ command: "COURSE_OFFERING_DELETE", targetTable: "course_offerings" }, async (adminProfile) => {
      const admin = createAdminClient();

      // 신청건수 체크 + 회차 비활성 표시 + deleted_at UPDATE를 하나의 트랜잭션으로 묶는다(회차는 지우지 않는다)
      // (원자성 위험 유형 2 해결). 예전엔 이 셋이 순차적인
      // 별개 호출이라, 회차만 지워지고 개설강의는 "활성"으로 남는 불일치가 가능했다.
      const { error } = await admin.rpc("delete_course_offering", {
        p_offering_id: offeringId,
        p_reason: reason,
        p_actor: adminProfile.id,
        p_actor_role: adminProfile.role,
      });

      // RPC의 예외 메시지가 이미 완결된 안내문이라 그대로 전달한다(이중으로 "삭제 실패:"를
      // 붙이지 않는다).
      if (error) {
        throw new UserFacingError(error.message);
      }

      return { result: null, targetId: offeringId, detail: { reason } };
    });

    revalidateOffering(offeringId);
  });
}

// 폐강 시작 — OPEN·CLOSED 개설(부터 마감 상태에서도 가능), 종료된 강의는 DB가 거부. RPC는 service_role 전용이라 createAdminClient.
// 결제 전 신청만 자동 정리하고 결제·무료(직권 부여) 수강생은 자동 환불·종료하지 않는다(관리자가 학생별로 처리, ADR-0021). 환불 사실(outbox)을 적재하지 않으므로 드레인은 하지 않는다. 메일은 Code-E.
export async function cancelCourseOffering(
  offeringId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      throw new UserFacingError("폐강 사유를 입력해 주세요.");
    }

    await runCommand({ command: "COURSE_OFFERING_CANCEL", targetTable: "course_offerings" }, async (adminProfile) => {
      const admin = createAdminClient();
      const { data: affected, error } = await admin.rpc("cancel_course_offering", {
        p_offering_id: offeringId,
        p_reason: reason,
        p_actor: adminProfile.id,
        p_actor_role: adminProfile.role,
      });

      if (error) {
        throw new UserFacingError(error.message);
      }

      // E-4(ADR-0021)부터 폐강 시작은 환불을 자동 개시하지 않는다 — 드레인할 사실이 없다.

      // Code-E / D7 — 메일 실패는 폐강·환불을 되돌리지 않는다.
      try {
        await notifyOfferingCancelled({
          offeringId,
          reason,
          affected: (affected ?? []) as {
            order_id: string;
            user_id: string;
            action: string;
          }[],
        });
      } catch (err) {
        console.error("폐강 안내 메일 일괄 실패(폐강은 유지):", err);
      }

      return {
        result: null,
        targetId: offeringId,
        detail: { reason, affected },
      };
    });

    revalidateOffering(offeringId);
    // 성공 = 폐강 "시작"이 접수된 것이다(OPEN·CLOSED → CANCELLING). 결제 완료·무료(직권 부여) 수강생은 자동으로 환불·종료되지 않는다 —
    // 관리자가 학생별로 처리하고(전액 환불 / 환불 없이 종료), 모두 처리되면 "마무리 확인"으로 완료한다(ADR-0021).
    return "폐강을 시작했습니다. 개설강의 상세의 「수강생 처리」에서 결제·직권 수강생을 학생별로 처리한 뒤 '폐강 마무리 확인'을 누르세요.";
  });
}

// CANCELLING이고 미정리 신청서 0건일 때만 CANCELLED.
export async function completeCourseOfferingCancel(
  offeringId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    // F-6: 탈퇴 등으로 미환불금이 남았으나 환불하지 않고 마무리하기로 확인한 주문 목록 및 사유 파싱
    // formData 에서 "ack_order_id" (배열 또는 다중 키)와 "ack_reason" 파싱
    const ackOrderIds = formData.getAll("ack_order_id").map(String).filter(Boolean);
    const ackReasons = formData.getAll("ack_reason").map(String);
    const acknowledgedList: { order_id: string; reason: string }[] = [];
    for (let i = 0; i < ackOrderIds.length; i++) {
      acknowledgedList.push({
        order_id: ackOrderIds[i],
        reason: ackReasons[i]?.trim() || "관리자 확인(환불 없이 마무리)",
      });
    }
    const ackSet = new Set(ackOrderIds);

    await runCommand(
      { command: "COURSE_OFFERING_CANCEL_COMPLETE", targetTable: "course_offerings" },
      async (adminProfile) => {
        // 결제 원장 및 이용권/주문 미처리 확인. 확인된 주문(ackSet)은 건너뛴다.
        const blockers = await findOfferingCancelBlockers(offeringId, ackSet);
        if (blockers.length > 0) {
          throw new UserFacingError(
            `처리가 끝나지 않은 건이 ${blockers.length}건 있어 폐강을 마무리할 수 없습니다: ${blockers
              .map((b) => `${b.orderId.slice(0, 8)} — ${b.reason}`)
              .join(" / ")}`,
          );
        }
        const admin = createAdminClient();
        const { error } = await admin.rpc("complete_course_offering_cancel", {
          p_offering_id: offeringId,
          p_actor: adminProfile.id,
          p_actor_role: adminProfile.role,
          p_acknowledged: acknowledgedList,
        });

        if (error) {
          throw new UserFacingError(error.message);
        }

        return { result: null, targetId: offeringId, detail: { acknowledged: acknowledgedList } };
      },
    );

    revalidateOffering(offeringId);
    return "폐강을 완료했습니다.";
  });
}

// 폐강 철회 — CANCELLING 또는 CANCELLED 상태의 개설강의를 관리자가 사유를 적고 OPEN/CLOSED로 되돌린다.
// 되돌릴 수 없는 신청(환불, 환불 없는 종료 등)은 그대로 두고, 개설강의 상태와 사건(CANCEL_REVOKED)만 기록한다.
export async function revokeOfferingCancel(
  offeringId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) throw new UserFacingError("폐강 철회 사유를 입력해 주세요.");
    const targetStatus = String(formData.get("targetStatus") ?? "CLOSED").trim();
    if (targetStatus !== "OPEN" && targetStatus !== "CLOSED") {
      throw new UserFacingError("복귀 상태는 OPEN 또는 CLOSED만 선택할 수 있습니다.");
    }

    await runCommand(
      { command: "COURSE_OFFERING_CANCEL_REVOKE", targetTable: "course_offerings" },
      async (adminProfile) => {
        const admin = createAdminClient();
        const { error } = await admin.rpc("revoke_course_offering_cancel", {
          p_offering_id: offeringId,
          p_actor_id: adminProfile.id,
          p_actor_role: adminProfile.role,
          p_reason: reason,
          p_target_status: targetStatus,
        });

        if (error) {
          throw new UserFacingError(error.message);
        }

        return { result: null, targetId: offeringId, detail: { reason, targetStatus } };
      },
    );

    revalidateOffering(offeringId);
    return "폐강을 철회했습니다.";
  });
}

// 강의 종료(ADR-0022) — 종강일이 지난 개설강의를 관리자가 직접 종료한다(수동 종료 설정이 꺼져 있어도 된다). 비고 필수.
// 결제 전 신청 정리·이용권 회수 사실 적재는 DB 함수 end_course_offering()이 한 트랜잭션으로 하고, 이용권·디스코드 역할 회수는 아웃박스를 거쳐
// 이용권 모듈이 한다(주문 상태·결제 상태는 그대로). 즉시 한 번 드레인해 회수가 바로 반영되게 한다 — 실패해도 DB 기록은 끝났고 다음 드레인에서 재시도된다.
export async function endCourseOffering(
  offeringId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const note = String(formData.get("note") ?? "").trim();
    if (!note) throw new UserFacingError("종료 비고를 입력해 주세요.");

    const revoked = await runCommand({ command: "COURSE_OFFERING_END", targetTable: "course_offerings" }, async (adminProfile) => {
      const admin = createAdminClient();
      const { data, error } = await admin.rpc("end_course_offering", {
        p_offering_id: offeringId,
        p_actor: adminProfile.id,
        p_actor_role: adminProfile.role,
        p_note: note,
      });
      if (error) throw new UserFacingError(error.message);
      try {
        await runOutboxBatch();
      } catch (err) {
        console.error("강의 종료 직후 아웃박스 드레인 실패(다음 드레인에서 재시도):", err);
      }
      return { result: Number(data ?? 0), targetId: offeringId, detail: { note, revoke_facts: data } };
    });

    revalidateOffering(offeringId);
    revalidatePath("/student");
    return `강의를 종료했습니다. 수강생 ${revoked}명의 이용권·디스코드 역할이 회수됩니다(주문·결제 상태는 그대로).`;
  });
}

// 강의 종료 취소(E-3 결정 12) — 잘못 종료했을 때 되돌린다. 종료 기록을 비우고 「수동 종료」를 켜며(크론이 다시 종료하지 않게),
// 승인된 주문마다 이용권을 새 행으로 다시 부여한다(옛 회수 행은 이력). 종료 때 정리된 결제 전 신청과 종료 뒤 환불·탈퇴로 취소된 주문은 되살리지 않는다.
export async function cancelCourseOfferingEnd(
  offeringId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) throw new UserFacingError("종료 취소 사유를 입력해 주세요.");

    const regranted = await runCommand({ command: "COURSE_OFFERING_END_CANCEL", targetTable: "course_offerings" }, async (adminProfile) => {
      const admin = createAdminClient();
      const { data, error } = await admin.rpc("reopen_course_offering", {
        p_offering_id: offeringId,
        p_actor: adminProfile.id,
        p_actor_role: adminProfile.role,
        p_reason: reason,
      });
      if (error) throw new UserFacingError(error.message);
      try {
        await runOutboxBatch();
      } catch (err) {
        console.error("강의 종료 취소 직후 아웃박스 드레인 실패(다음 드레인에서 재시도):", err);
      }
      return { result: Number(data ?? 0), targetId: offeringId, detail: { reason, regrant_facts: data } };
    });

    revalidateOffering(offeringId);
    revalidatePath("/student");
    return `강의 종료를 취소했습니다. 수강생 ${regranted}명의 이용권을 다시 부여합니다. 「수동 종료」 설정이 켜졌습니다 — 다시 종료하려면 직접 종료하세요.`;
  });
}

