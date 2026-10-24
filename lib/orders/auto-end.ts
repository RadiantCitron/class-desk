import { createAdminClient } from "@/lib/supabase/admin";

// 강의 자동 종료(ADR-0022) — 종강일이 지난 개설강의를 SYSTEM으로 종료한다. 하루 1회 크론(`/api/cron/outbox`, 한국 03:00)이
// 드레인 직전에 부른다. 종료의 실제 일(결제 전 신청 정리, 이용권 회수 사실 적재)은 DB 함수 end_course_offering()이 한 트랜잭션으로 하고,
// 이용권·디스코드 역할 회수는 아웃박스를 거쳐 이용권 모듈이 한다.
//
//  · 대상: 모집중·마감 상태, 삭제 안 됨, 아직 종료 안 됨, 「수동 종료」 설정이 꺼져 있고(켜 두면 크론이 건드리지 않는다), 종강일이 있고 이미 지남.
//    (종강일이 없는 강의는 수동 종료만. 개강 전이거나 폐강 진행·완료는 함수가 거부한다.)
//  · 한 건이 실패해도 나머지는 계속한다. 실패는 dead_letters(INTERNAL)에 남겨 관리자가 보게 한다. throw하지 않는다 — 크론의 드레인을 막지 않는다.
//  · 감사 로그(audit_logs)는 행위자 id가 필수라 SYSTEM은 남기지 않는다. 대신 개설강의 행에 ended_at·end_note(「기간 만료 자동 종료」)와 ended_by = null이 남는다.
export async function endExpiredOfferings(): Promise<{ ended: number; failed: number }> {
  const admin = createAdminClient();
  let ended = 0;
  let failed = 0;

  const { data: due, error } = await admin
    .from("course_offerings")
    .select("id")
    .in("status", ["OPEN", "CLOSED"])
    .is("deleted_at", null)
    .is("ended_at", null)
    .eq("manual_end", false)
    .not("ends_at", "is", null)
    .lt("ends_at", new Date().toISOString())
    .order("ends_at");
  if (error) {
    console.error("자동 종료 대상 조회 실패:", error.message);
    await recordFailure(admin, null, `자동 종료 대상 조회 실패: ${error.message}`);
    return { ended, failed: 1 };
  }

  for (const offering of due ?? []) {
    const { error: endError } = await admin.rpc("end_course_offering", {
      p_offering_id: offering.id,
      p_actor: null,
      p_actor_role: "SYSTEM",
      p_note: "기간 만료 자동 종료",
    });
    if (endError) {
      failed += 1;
      console.error("강의 자동 종료 실패:", offering.id, endError.message);
      await recordFailure(admin, offering.id as string, endError.message);
    } else {
      ended += 1;
    }
  }
  return { ended, failed };
}

async function recordFailure(admin: ReturnType<typeof createAdminClient>, offeringId: string | null, message: string) {
  try {
    await admin.from("dead_letters").insert({
      source: "INTERNAL",
      payload: { handler: "endExpiredOfferings", offering_id: offeringId },
      error_message: `강의 자동 종료 실패: ${message}${offeringId ? ` offering_id=${offeringId}` : ""}`,
    });
  } catch (err) {
    console.error("강의 자동 종료 실패 DLQ 적재 실패:", err);
  }
}
