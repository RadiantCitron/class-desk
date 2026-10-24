import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getRequiredTermsForOffering, TERMS_TYPE_LABELS } from "@/lib/terms";
import { one } from "@/lib/supabase/relations";
import { runQuery } from "@/lib/commands/run-command";
import { checkRail } from "@/lib/commands/check";
import { offeringRequiresDiscord } from "@/lib/guards/discord-linked";
import { formatSessions } from "@/lib/shared/schedule-label";

export type ApplyView = {
  offeringId: string;
  /** "과목명 (회차) 수강 신청" — h1. */
  title: string;
  /** "50,000원 · 잔여 5자리" */
  meta: string;
  location: string | null;
  scheduleText: string | null;
  description: string | null;
  notice: string | null;
  /** 디스코드 강의인데 미연결인 경우 안내 문구 */
  discordNotice: string | null;
  /** 화면에 보일 약관(이미 최신판에 동의한 것은 제외). title은 "약관종류 (버전)". */
  terms: { type: string; title: string; content: string }[];
  canSubmit: boolean;
  /** 아직 등록되지 않은 필수 약관 이름을 ", "로 이은 문구. 없으면 null. */
  missingTermsText: string | null;
};

// 자체 신청 폼(Tally 철거). 신청 버튼은 서버에서 정원/상태를 이미 확인한 뒤에만 렌더링한다(클라이언트에서 조건 판단 금지).
export async function loadApply(offeringId: string): Promise<ApplyView> {
  return runQuery({ command: "STUDENT_APPLY_VIEW", onDenied: () => redirect("/student") }, async (profile) => {

    // 이 화면 자체가 통제(시스템·주문 모듈·이 화면 스위치)로 막히면 학생 홈으로 돌려보낸다 — 홈이 사유를 보여 준다.
  // 수강 신청 통제(명령 레일). 대시보드가 이미 "신청하기" 버튼을 이유와 함께 교체해 보여주므로 여기서는 직접 URL 접근만 방어하고 그냥 돌려보낸다.
    if (!(await checkRail("ORDER_APPLY", profile)).ok) {
      redirect("/student");
    }

    const supabase = await createClient();

    const { data: offering } = await supabase
      .from("course_offerings")
      .select(
        "id, label, capacity, remaining_seats, price, location, notice_text, status, recruit_opens_at, opens_at, required_terms_types, grants, courses(name, description), course_sessions(session_date, start_time, end_time, deactivated_at)",
      )
      .eq("id", offeringId)
      .is("deleted_at", null)
      .maybeSingle();

    // 모집기간(모집 시작 ≤ 지금 < 개강) 강제: create_order()도 동일 조건을 DB에서
    // 다시 확인하므로(2중 방어) 여기서는 UX용 1차 체크다.
    const now = new Date();
    const withinWindow =
      !!offering &&
      new Date(offering.recruit_opens_at) <= now &&
      now < new Date(offering.opens_at);

    if (!offering || offering.status !== "OPEN" || !withinWindow) {
      redirect("/student");
    }

    // F-5: 온라인(디스코드) 수업이어도 미연결 학생의 신청을 막지 않는다(리다이렉트 폐지).
    // 대신 신청 화면에서 결제 전 연결 필요 안내를 보여준다.
    const requiresDiscord = offeringRequiresDiscord(offering.grants);
    const discordNotice =
      requiresDiscord && !profile.discordId
        ? "디스코드로 진행하는 강의입니다 — 결제 전에 디스코드 연결이 필요합니다."
        : null;

    // F-8: 재신청 허용 — 종결된(REJECTED, CANCELLED) 주문이 있어도 살아 있는 신청(PENDING, APPROVED)이 없을 때만 신청 가능
    const { data: existing } = await supabase
      .from("orders")
      .select("id")
      .eq("user_id", profile.id)
      .eq("course_offering_id", offeringId)
      .in("status", ["PENDING", "APPROVED"])
      .limit(1)
      .maybeSingle();

    if (existing || offering.remaining_seats <= 0) {
      redirect("/student");
    }

    // 신청 시 받아야 하는 약관 목록 — PRIVACY_USE·THIRD_PARTY_SHARE(공통, 실 PG) + 이 개설강의의 required_terms_types. 이미 최신 버전에 동의한 항목은 화면에 다시 노출하지 않는다.
    const requiredTerms = await getRequiredTermsForOffering(
      supabase,
      profile.id,
      (offering.required_terms_types as string[]) ?? [],
    );
    const termsToShow = requiredTerms.filter((item) => item.terms && !item.alreadyAgreed);
    const missingTerms = requiredTerms.filter((item) => !item.terms);

    const courseName = one(offering.courses)?.name ?? "";
    const sessions = offering.course_sessions ?? [];

    return {
      offeringId,
      title: `${courseName}${offering.label ? ` (${offering.label})` : ""} 수강 신청`,
      meta: `${offering.price.toLocaleString()}원 · 잔여 ${offering.remaining_seats}자리`,
      location: offering.location || null,
      scheduleText: formatSessions(sessions) || null,
      description: one(offering.courses)?.description || null,
      notice: offering.notice_text || null,
      discordNotice,
      terms: termsToShow.map((item) => ({
        type: item.type,
        title: `${TERMS_TYPE_LABELS[item.type] ?? item.type} (${item.terms!.version})`,
        content: item.terms!.content,
      })),
      canSubmit: missingTerms.length === 0,
      missingTermsText:
        missingTerms.length > 0 ? missingTerms.map((item) => TERMS_TYPE_LABELS[item.type] ?? item.type).join(", ") : null,
    };
  });
}
