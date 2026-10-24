import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { summarizeSessions } from "@/lib/shared/session-progress";

// 통합 테스트 — 로컬 Supabase 필요. : 총/지난/다음 회차의 정의가 DB 함수(offering_session_stats)와 TS 순수 함수
// (summarizeSessions) 두 곳에 있으므로, 같은 회차 데이터에서 결과가 같은지 여러 기준 날짜로 확인한다. 정의를 바꾸면 둘을 같이 고쳐야 한다.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다. .env.local을 확인하고 " +
      "`npm run db:start`로 로컬 Supabase를 띄운 뒤 다시 실행하세요.",
  );
}
const admin = createClient(url, key, { auth: { persistSession: false } });

// 행위자(p_actor)와 삭제자(deleted_by FK)로 쓸 회원 행. DB를 막 초기화했으면 회원이 하나도 없으므로 시험이 직접 만든다.
async function ensureActor(): Promise<string> {
  const { data: existing } = await admin.from("users").select("id").limit(1).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await admin
    .from("users")
    .insert({ auth_user_id: randomUUID(), email: `vitest-actor-${randomUUID()}@example.com`, role: "STUDENT" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`행위자 생성 실패: ${error?.message}`);
  return data.id;
}
const year = 5500 + Math.floor(Math.random() * 400);

describe("회차 파생값 DB↔TS 일치 — 통합", { timeout: 60_000 }, () => {
  let offeringId: string | null = null;

  afterEach(async () => {
    const actorId = await ensureActor();
    if (offeringId) {
      await admin.rpc("delete_course_offering", { p_offering_id: offeringId, p_reason: "vitest 정리", p_actor: actorId, p_actor_role: "ADMIN" });
    }
    offeringId = null;
  });

  it("활성 회차 4개 중 1개를 취소한 개설강의에서 기준 날짜별 total/past/first/last/next가 같다", async () => {
    const actorId = await ensureActor();
    const { data: course, error: courseError } = await admin.from("courses").insert({ name: `vitest-progress-${randomUUID()}`, category: "TEST" }).select("id").single();
    expect(courseError).toBeNull();
    const dates = [`${year}-03-03`, `${year}-03-10`, `${year}-03-17`, `${year}-03-24`];
    const { data: id, error } = await admin.rpc("create_course_offering", {
      p_course_id: course!.id,
      p_label: "vitest-progress",
      p_capacity: 5,
      p_price: 10000,
      p_location: null,
      p_required_terms_types: [],
      p_grants: [{ type: "COURSE_ACCESS" }],
      p_recruit_opens_at: "2026-01-01T00:00:00Z",
      p_sessions: dates.map((date) => ({ date, start: "10:00", end: "12:00" })),
      p_actor: actorId,
      p_actor_role: "ADMIN",
      p_auto_approve: false,
    });
    expect(error).toBeNull();
    offeringId = id as string;

    const { data: target } = await admin.from("course_sessions").select("id").eq("course_offering_id", id).eq("session_date", dates[2]).single();
    const cancelled = await admin.rpc("cancel_course_session", { p_session_id: target!.id, p_actor: actorId, p_actor_role: "ADMIN", p_reason: "vitest" });
    expect(cancelled.error).toBeNull();

    const { data: rows } = await admin.from("course_sessions").select("session_date, deactivated_at").eq("course_offering_id", id);
    for (const today of [`${year}-03-02`, dates[0], `${year}-03-05`, dates[1], dates[2], dates[3], `${year}-03-25`]) {
      const { data: stats, error: statsError } = await admin.rpc("offering_session_stats", { p_offering_id: id, p_today: today });
      expect(statsError).toBeNull();
      const db = (stats as { total_count: number; past_count: number; first_date: string | null; last_date: string | null; next_date: string | null }[])[0];
      const ts = summarizeSessions(rows ?? [], today);
      expect({ total: db.total_count, past: db.past_count, first: db.first_date, last: db.last_date, next: db.next_date }, `기준 ${today}`).toEqual(ts);
    }
  });
});
