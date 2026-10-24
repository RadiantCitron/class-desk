import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";

describe("개설강의 사건 원장(course_offering_events) — 통합", { timeout: 60_000 }, () => {
  const admin = createAdminClient();
  let offeringIds: string[] = [];
  let userIds: string[] = [];
  let courseId: string | null = null;

  afterEach(async () => {
    const actorId = await ensureAdmin();
    for (const id of offeringIds) {
      await admin.rpc("delete_course_offering", {
        p_offering_id: id,
        p_reason: "vitest 정리",
        p_actor: actorId,
        p_actor_role: "ADMIN",
      });
    }
    for (const uid of userIds) {
      await admin.from("users").delete().eq("id", uid);
    }
    offeringIds = [];
    userIds = [];
  });

  async function ensureAdmin(): Promise<string> {
    const { data } = await admin.from("users").select("id").eq("role", "ADMIN").limit(1).maybeSingle();
    if (data?.id) return data.id;
    const { data: created } = await admin
      .from("users")
      .insert({ auth_user_id: randomUUID(), email: `vitest-adm-${randomUUID()}@example.com`, role: "ADMIN" })
      .select("id")
      .single();
    userIds.push(created!.id);
    return created!.id;
  }

  async function ensureCourse(): Promise<string> {
    if (courseId) return courseId;
    const { data } = await admin
      .from("courses")
      .insert({ name: `vitest-course-${randomUUID()}`, category: "TEST" })
      .select("id")
      .single();
    courseId = data!.id;
    return courseId!;
  }

  it("개설강의 생성·수정·상태변경·회차추가·회차취소·삭제 시 원장에 사건이 순서대로 기록된다", async () => {
    const adminId = await ensureAdmin();
    const cId = await ensureCourse();
    const year = 6500 + Math.floor(Math.random() * 200);

    // 1. 개설강의 생성 (CREATED)
    const { data: offId, error: createErr } = await admin.rpc("create_course_offering", {
      p_course_id: cId,
      p_label: "원장테스트",
      p_capacity: 10,
      p_price: 50000,
      p_location: "강남",
      p_required_terms_types: [],
      p_grants: [{ type: "COURSE_ACCESS" }],
      p_recruit_opens_at: "2026-01-01T00:00:00Z",
      p_sessions: [{ date: `${year}-10-01`, start: "14:00", end: "16:00" }],
      p_actor: adminId,
      p_actor_role: "ADMIN",
      p_auto_approve: false,
    });
    expect(createErr).toBeNull();
    const offeringId = offId as string;
    offeringIds.push(offeringId);

    // 2. 수정 (UPDATED)
    const { error: updateErr } = await admin.rpc("update_course_offering", {
      p_offering_id: offeringId,
      p_actor: adminId,
      p_actor_role: "ADMIN",
      p_reason: "수정 테스트",
      p_patch: { price: 45000 },
    });
    expect(updateErr).toBeNull();

    // 3. 상태 변경 (STATUS_CHANGED: CLOSED)
    const { error: statusErr } = await admin.rpc("set_course_offering_status", {
      p_offering_id: offeringId,
      p_next_status: "CLOSED",
      p_reason: "마감 테스트",
      p_actor: adminId,
      p_actor_role: "ADMIN",
    });
    expect(statusErr).toBeNull();

    // 4. 상태 변경 (STATUS_CHANGED: OPEN)
    const { error: reopenStatusErr } = await admin.rpc("set_course_offering_status", {
      p_offering_id: offeringId,
      p_next_status: "OPEN",
      p_reason: "재개 테스트",
      p_actor: adminId,
      p_actor_role: "ADMIN",
    });
    expect(reopenStatusErr).toBeNull();

    // 5. 회차 추가 (SESSION_ADDED)
    const { data: sessId, error: addSessErr } = await admin.rpc("add_course_session", {
      p_offering_id: offeringId,
      p_actor: adminId,
      p_actor_role: "ADMIN",
      p_reason: "보강 추가",
      p_date: `${year}-10-08`,
      p_start: "14:00",
      p_end: "16:00",
    });
    expect(addSessErr).toBeNull();

    // 6. 회차 취소 (SESSION_CANCELLED)
    const { error: cancelSessErr } = await admin.rpc("cancel_course_session", {
      p_session_id: sessId as string,
      p_actor: adminId,
      p_actor_role: "ADMIN",
      p_reason: "보강 취소",
    });
    expect(cancelSessErr).toBeNull();

    // 7. 사건 원장 조회 및 검증
    const { data: events, error: evtErr } = await admin
      .from("course_offering_events")
      .select("event_type, actor, actor_user_id, reason, before, after")
      .eq("course_offering_id", offeringId)
      .order("created_at", { ascending: true });

    expect(evtErr).toBeNull();
    expect(events).toBeDefined();
    expect(events!.length).toBe(6);

    expect(events![0].event_type).toBe("CREATED");
    expect(events![0].actor).toBe("ADMIN");
    expect(events![0].actor_user_id).toBe(adminId);
    expect(events![0].reason).toBe("강의 개설");
    expect(events![0].after).toMatchObject({ label: "원장테스트", price: 50000 });

    expect(events![1].event_type).toBe("UPDATED");
    expect(events![1].reason).toBe("수정 테스트");
    expect(events![1].after).toMatchObject({ price: 45000 });

    expect(events![2].event_type).toBe("STATUS_CHANGED");
    expect(events![2].reason).toBe("마감 테스트");
    expect(events![2].after).toMatchObject({ status: "CLOSED" });

    expect(events![3].event_type).toBe("STATUS_CHANGED");
    expect(events![3].reason).toBe("재개 테스트");
    expect(events![3].after).toMatchObject({ status: "OPEN" });

    expect(events![4].event_type).toBe("SESSION_ADDED");
    expect(events![4].reason).toBe("보강 추가");
    expect(events![4].after).toMatchObject({ session_date: `${year}-10-08` });

    expect(events![5].event_type).toBe("SESSION_CANCELLED");
    expect(events![5].reason).toBe("보강 취소");
    expect(events![5].before).toMatchObject({ session_date: `${year}-10-08` });
  });
});
