import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { checkSystemIntegrity, expectedOfferingSchedule } from "./checks";

/**
 * 대사 ⑫ — 개설강의의 개강·종료 캐시(opens_at/ends_at)와 활성 회차에서 계산한 값의 어긋남(OFFERING_SCHEDULE_DRIFT).
 * 로컬 Supabase 필요, 외부 호출 없음. 전역 겹침 제약 때문에 먼 미래의 무작위 연도를 쓴다.
 */

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
const year = 5000 + Math.floor(Math.random() * 500);

describe("expectedOfferingSchedule (단위 성격)", () => {
  it("활성 회차의 첫 시작·마지막 끝(KST), 비활성 제외, 없으면 null", () => {
    const sessions = [
      { session_date: "2035-03-10", start_time: "19:00:00", end_time: "21:00:00", deactivated_at: null },
      { session_date: "2035-03-03", start_time: "10:30:00", end_time: "12:00:00", deactivated_at: null },
      { session_date: "2035-02-01", start_time: "09:00:00", end_time: "10:00:00", deactivated_at: "2035-01-01T00:00:00Z" },
    ];
    expect(expectedOfferingSchedule(sessions)).toEqual({
      opensAt: new Date("2035-03-03T10:30:00+09:00").getTime(),
      endsAt: new Date("2035-03-10T21:00:00+09:00").getTime(),
    });
    expect(expectedOfferingSchedule([])).toBeNull();
    expect(expectedOfferingSchedule([{ ...sessions[0], deactivated_at: "x" }])).toBeNull();
  });
});

describe("대사 ⑫ 개강·종료 캐시 어긋남 — 통합", () => {
  let offeringIds: string[] = [];
  let courseId: string | null = null;

  afterEach(async () => {
    const actorId = await ensureActor();
    for (const id of offeringIds) {
      await admin.from("dead_letters").delete().eq("source", "INTEGRITY").contains("payload", { offering_id: id });
      await admin.rpc("delete_course_offering", { p_offering_id: id, p_reason: "vitest 정리", p_actor: actorId, p_actor_role: "ADMIN" });
    }
    offeringIds = [];
  });

  async function create(date: string, second: string) {
    if (!courseId) {
      const { data } = await admin.from("courses").insert({ name: `vitest-drift-${randomUUID()}`, category: "TEST" }).select("id").single();
      courseId = data!.id;
    }
    const actorId = await ensureActor();
    const { data: id, error } = await admin.rpc("create_course_offering", {
      p_course_id: courseId,
      p_label: "vitest-drift",
      p_capacity: 5,
      p_price: 10000,
      p_location: null,
      p_required_terms_types: [],
      p_grants: [{ type: "COURSE_ACCESS" }],
      p_recruit_opens_at: "2026-01-01T00:00:00Z",
      p_sessions: [
        { date, start: "10:00", end: "12:00" },
        { date: second, start: "10:00", end: "12:00" },
      ],
      p_actor: actorId,
      p_actor_role: "ADMIN",
      p_auto_approve: false,
    });
    if (error) throw new Error(error.message);
    offeringIds.push(id as string);
    return id as string;
  }

  async function warnings(id: string) {
    const { data, error } = await admin
      .from("dead_letters")
      .select("payload")
      .eq("source", "INTEGRITY")
      .contains("payload", { offering_id: id, check: "OFFERING_SCHEDULE_DRIFT" });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  it("트리거가 맞춰 둔 값이면 경고하지 않고, 컬럼을 직접 고쳐 어긋나면 경고한다(재실행해도 중복 없음)", async () => {
    const ok = await create(`${year}-03-01`, `${year}-03-08`);
    await checkSystemIntegrity();
    expect(await warnings(ok)).toHaveLength(0);

    const bad = await create(`${year}-04-01`, `${year}-04-08`);
    await admin.from("course_offerings").update({ opens_at: "2030-01-01T00:00:00Z" }).eq("id", bad);
    await checkSystemIntegrity();
    const first = await warnings(bad);
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(first[0].payload).toMatchObject({ expected_opens_at: new Date(`${year}-04-01T10:00:00+09:00`).toISOString() });
    await checkSystemIntegrity();
    expect(await warnings(bad)).toHaveLength(first.length);
    expect(await warnings(ok)).toHaveLength(0);
  });

  it("종강 값(ends_at)만 어긋나도, 비워도(null) 경고한다 / 회차를 취소하면 트리거가 다시 맞춰 경고가 새로 생기지 않는다", async () => {
    const id = await create(`${year}-05-01`, `${year}-05-08`);
    await admin.from("course_offerings").update({ ends_at: null }).eq("id", id);
    await checkSystemIntegrity();
    expect((await warnings(id)).length).toBeGreaterThanOrEqual(1);

    // 어긋남을 해소하는 정상 경로: 회차 변경 → 트리거 재계산. 경고를 지우고 다시 점검하면 새 경고가 없다.
    const actorId = await ensureActor();
    const added = await admin.rpc("add_course_session", { p_offering_id: id, p_actor: actorId, p_actor_role: "ADMIN", p_reason: "vitest", p_date: `${year}-05-02`, p_start: "10:00", p_end: "12:00" });
    expect(added.error).toBeNull();
    await admin.from("dead_letters").delete().eq("source", "INTEGRITY").contains("payload", { offering_id: id });
    await checkSystemIntegrity();
    expect(await warnings(id)).toHaveLength(0);
  });
});
