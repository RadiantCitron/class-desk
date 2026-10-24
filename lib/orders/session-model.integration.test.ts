import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { parseSessionRows } from "@/lib/orders/session-rows";

// 통합 테스트 — 실제 로컬 Supabase가 필요하다. [로컬] 전용.
// 서버 액션이 하는 일(폼 입력 → expandSessionDates → create_course_offering RPC의 p_sessions)이 PostgREST를 통해
// 실제로 동작하는지 확인한다(SQL 시험은 psql로 직접 호출하므로 인자 이름·jsonb 직렬화는 여기서 처음 확인된다).

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

// 전역 겹침 제약(강사 1인) 때문에 다른 시험·실행과 날짜가 겹치지 않도록 아주 먼 미래의 무작위 연도를 쓴다.
const year = 3000 + Math.floor(Math.random() * 2000);

describe("날짜별 회차 생성 RPC — 통합", { timeout: 60_000 }, () => {
  let offeringIds: string[] = [];
  let courseId: string | null = null;

  afterEach(async () => {
    const actorId = await ensureActor();
    for (const id of offeringIds) {
      {
        // 삭제 표시 뒤 회차가 비활성으로 보존된다(다음 실행과 시간대가 겹치지 않게).
        await admin.rpc("delete_course_offering", { p_offering_id: id, p_reason: "vitest 정리", p_actor: actorId, p_actor_role: "ADMIN" });
      }
    }
    offeringIds = [];
  });

  async function course() {
    if (courseId) return courseId;
    const { data, error } = await admin.from("courses").insert({ name: `vitest-sessions-${randomUUID()}`, category: "TEST" }).select("id").single();
    if (error || !data) throw new Error(`강의 생성 실패: ${error?.message}`);
    courseId = data.id;
    return data.id;
  }

  async function create(sessions: { date: string; start: string; end: string }[], recruit = "2026-01-01T00:00:00Z") {
    const actorId = await ensureActor();
    return admin.rpc("create_course_offering", {
      p_course_id: await course(),
      p_label: "vitest",
      p_capacity: 5,
      p_price: 10000,
      p_location: null,
      p_required_terms_types: [],
      p_grants: [{ type: "COURSE_ACCESS" }],
      p_recruit_opens_at: recruit,
      p_sessions: sessions,
      p_actor: actorId,
      p_actor_role: "ADMIN",
      p_auto_approve: false,
    });
  }

  it("날짜별 회차(회차마다 시각이 다름)로 개설하면 개강·종료가 회차에서 계산된다(한국 시각)", async () => {
    // 서버 액션과 같은 경로: 폼이 보낸 JSON → parseSessionRows → RPC. 회차마다 시각이 달라도 된다.
    const sessions = parseSessionRows(
      JSON.stringify([
        { date: `${year}-03-09`, start: "19:00", end: "21:00" },
        { date: `${year}-03-02`, start: "10:30", end: "12:00" },
        { date: `${year}-03-04`, start: "19:00", end: "21:00" },
      ]),
    );
    const { data: id, error } = await create(sessions);
    expect(error).toBeNull();
    offeringIds.push(id as string);

    const { data: rows } = await admin.from("course_sessions").select("session_date, start_time, end_time, deactivated_at").eq("course_offering_id", id).order("session_date");
    expect(rows?.map((r) => r.session_date)).toEqual(sessions.map((s) => s.date));
    expect(rows).toHaveLength(sessions.length);
    expect(rows?.every((r) => r.deactivated_at === null)).toBe(true);

    const { data: offering } = await admin.from("course_offerings").select("opens_at, ends_at").eq("id", id).single();
    expect(new Date(offering!.opens_at).toISOString()).toBe(new Date(`${year}-03-02T10:30:00+09:00`).toISOString());
    expect(new Date(offering!.ends_at!).toISOString()).toBe(new Date(`${year}-03-09T21:00:00+09:00`).toISOString());
  });

  it("같은 시간대 회차는 거부되고 개설강의도 남지 않는다 / 회차 없음·모집 시작 오류도 거부", async () => {
    const day = `${year}-06-10`;
    const ok = await create([{ date: day, start: "10:00", end: "12:00" }]);
    expect(ok.error).toBeNull();
    offeringIds.push(ok.data as string);

    const { count: before } = await admin.from("course_offerings").select("id", { count: "exact", head: true });
    const overlap = await create([{ date: day, start: "11:00", end: "13:00" }]);
    expect(overlap.error?.message).toContain("course_sessions_no_overlap_active");
    const { count: after } = await admin.from("course_offerings").select("id", { count: "exact", head: true });
    expect(after).toBe(before);

    const empty = await create([]);
    expect(empty.error?.message).toContain("회차가 1개 이상");

    const lateRecruit = await create([{ date: `${year}-07-01`, start: "10:00", end: "12:00" }], `${year}-07-01T10:00:00+09:00`);
    expect(lateRecruit.error?.message).toContain("모집 시작은 개강");
  });

  it("update_course_offering는 opens_at/ends_at 패치를 거부한다", async () => {
    const { data: id, error } = await create([{ date: `${year}-09-05`, start: "10:00", end: "12:00" }]);
    expect(error).toBeNull();
    offeringIds.push(id as string);
    const actorId = await ensureActor();
    const res = await admin.rpc("update_course_offering", {
      p_offering_id: id,
      p_actor: actorId,
      p_actor_role: "ADMIN",
      p_reason: "vitest",
      p_patch: { opens_at: "2031-01-01T00:00:00Z" },
    });
    expect(res.error?.message).toContain("수정할 수 없는 항목");
  });

  it("add_course_session / cancel_course_session — 개강 전·신청 없음일 때 추가·취소되고 개강·종료가 다시 계산된다", async () => {
    const { data: id, error } = await create([{ date: `${year}-10-12`, start: "10:00", end: "12:00" }]);
    expect(error).toBeNull();
    offeringIds.push(id as string);
    const actorId = await ensureActor();

    const added = await admin.rpc("add_course_session", {
      p_offering_id: id,
      p_actor: actorId,
      p_actor_role: "ADMIN",
      p_reason: "vitest 보강",
      p_date: `${year}-10-05`,
      p_start: "09:00",
      p_end: "10:00",
    });
    expect(added.error).toBeNull();
    let { data: off } = await admin.from("course_offerings").select("opens_at, ends_at").eq("id", id).single();
    expect(new Date(off!.opens_at).toISOString()).toBe(new Date(`${year}-10-05T09:00:00+09:00`).toISOString());
    expect(new Date(off!.ends_at!).toISOString()).toBe(new Date(`${year}-10-12T12:00:00+09:00`).toISOString());

    const noReason = await admin.rpc("cancel_course_session", { p_session_id: added.data, p_actor: actorId, p_actor_role: "ADMIN", p_reason: "  " });
    expect(noReason.error?.message).toContain("사유를 입력");

    const cancelled = await admin.rpc("cancel_course_session", { p_session_id: added.data, p_actor: actorId, p_actor_role: "ADMIN", p_reason: "vitest 취소" });
    expect(cancelled.error).toBeNull();
    ({ data: off } = await admin.from("course_offerings").select("opens_at, ends_at").eq("id", id).single());
    expect(new Date(off!.opens_at).toISOString()).toBe(new Date(`${year}-10-12T10:00:00+09:00`).toISOString());
    const { data: row } = await admin.from("course_sessions").select("deactivated_reason").eq("id", added.data).single();
    expect(row?.deactivated_reason).toBe("vitest 취소");

    // 남은 마지막 활성 회차는 취소할 수 없다
    const { data: last } = await admin.from("course_sessions").select("id").eq("course_offering_id", id).is("deactivated_at", null).single();
    const lastCancel = await admin.rpc("cancel_course_session", { p_session_id: last!.id, p_actor: actorId, p_actor_role: "ADMIN", p_reason: "vitest" });
    expect(lastCancel.error?.message).toContain("마지막 남은 회차");
  });
});
