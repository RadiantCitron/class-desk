import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { notifyOfferingCancelled } from "@/lib/notifications/offering-cancelled";

/**
 * Code-E — 폐강 안내 메일 → 로컬 Mailpit(54324).
 * `npm run test:integration` / 직접 vitest run.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요");
}
const admin = createClient(url, key, { auth: { persistSession: false } });

const MAILPIT = process.env.MAILPIT_API_URL ?? "http://127.0.0.1:54324";

async function mailpitSearch(query: string): Promise<{ total: number; messages: { Subject: string; To: { Address: string }[] }[] }> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`Mailpit search ${res.status}`);
  return res.json() as Promise<{ total: number; messages: { Subject: string; To: { Address: string }[] }[] }>;
}

describe("Code-E 폐강 안내 메일 — 통합", () => {
  const cleanupUserIds: string[] = [];
  const cleanupAuthIds: string[] = [];
  let courseId: string | null = null;
  let offeringId: string | null = null;
  let studentEmail = "";
  let studentUserId = "";

  beforeAll(async () => {
    studentEmail = `vitest-codee-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email: studentEmail,
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(authError?.message);
    cleanupAuthIds.push(authUser.user.id);

    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({ auth_user_id: authUser.user.id, email: studentEmail, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(profileError?.message);
    studentUserId = profile.id;
    cleanupUserIds.push(profile.id);

    const { data: course, error: courseError } = await admin
      .from("courses")
      .insert({ name: `vitest-codee-${randomUUID()}` })
      .select("id")
      .single();
    if (courseError || !course) throw new Error(courseError?.message);
    courseId = course.id;

    const { data: offering, error: offeringError } = await admin
      .from("course_offerings")
      .insert({
        course_id: courseId,
        label: "E회차",
        capacity: 5,
        remaining_seats: 5,
        price: 10000,
        location: "test",
        // 모집 중(모집 시작 ≤ 지금 < 개강). recruit_opens_at은 기본값이 없다.
        recruit_opens_at: new Date(Date.now() - 3_600_000).toISOString(),
        opens_at: new Date(Date.now() + 86_400_000).toISOString(),
        status: "OPEN",
        grants: [],
        required_terms_types: [],
      })
      .select("id")
      .single();
    if (offeringError || !offering) throw new Error(offeringError?.message);
    offeringId = offering.id;
  });

  afterAll(async () => {
    // 개설강의는 지우지 않고 db:reset이 정리한다.
    if (courseId) await admin.from("courses").delete().eq("id", courseId);
    for (const id of cleanupUserIds) await admin.from("users").delete().eq("id", id);
    for (const id of cleanupAuthIds) await admin.auth.admin.deleteUser(id);
  });

  it("notifyOfferingCancelled → Mailpit에 1통", async () => {
    const marker = `폐강-${randomUUID().slice(0, 8)}`;
    await notifyOfferingCancelled({
      offeringId: offeringId!,
      reason: marker,
      affected: [
        {
          order_id: randomUUID(),
          user_id: studentUserId,
          action: "ACTION_REQUIRED",
        },
      ],
    });

    // Mailpit 인덱싱 지연 대비
    let found = false;
    for (let i = 0; i < 10; i++) {
      const hit = await mailpitSearch(marker);
      if (hit.total > 0) {
        const msg = hit.messages[0];
        expect(msg.Subject).toContain("폐강 안내");
        expect(msg.To.some((t) => t.Address === studentEmail)).toBe(true);
        found = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(found).toBe(true);
  });
});
