import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

/**
 * Code-F — record_identity_link_failed → account_events IDENTITY_LINK_FAILED.
 * `npm run test:integration` / 직접 vitest run.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요");
}
const admin = createClient(url, key, { auth: { persistSession: false } });

describe("Code-F 디스코드 연결 실패 로그 — 통합", () => {
  const cleanupUserIds: string[] = [];
  const cleanupAuthIds: string[] = [];

  afterAll(async () => {
    // account_events는 append-only 트리거라 앱 경로로 DELETE 불가 — 테스트 사용자는
    // 탈퇴 표시만 하고 남긴다(이메일 UUID라 충돌 없음).
    for (const id of cleanupUserIds) {
      await admin.from("users").update({ withdrawn_at: new Date().toISOString() }).eq("id", id);
    }
    for (const id of cleanupAuthIds) {
      await admin.auth.admin.deleteUser(id);
    }
  });

  it("의도적 실패 1회 → account_events IDENTITY_LINK_FAILED 행", async () => {
    const email = `vitest-codef-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(authError?.message);
    cleanupAuthIds.push(authUser.user.id);

    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({ auth_user_id: authUser.user.id, email, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(profileError?.message);
    cleanupUserIds.push(profile.id);

    const { error: rpcError } = await admin.rpc("record_identity_link_failed", {
      p_user_id: profile.id,
      p_detail: {
        code: "discord_in_use",
        message: "vitest intentional fail",
      },
    });
    expect(rpcError).toBeNull();

    const { data: events, error: eventsError } = await admin
      .from("account_events")
      .select("event_type, actor, detail")
      .eq("user_id", profile.id)
      .eq("event_type", "IDENTITY_LINK_FAILED");
    expect(eventsError).toBeNull();
    expect(events).toHaveLength(1);
    expect(events![0].actor).toBe("SELF");
    expect(events![0].detail).toMatchObject({
      provider: "discord",
      code: "discord_in_use",
      message: "vitest intentional fail",
    });
  });

  it("CHECK가 IDENTITY_LINK_FAILED를 허용하고 UPDATE는 막힌다", async () => {
    const email = `vitest-codef-immut-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(authError?.message);
    cleanupAuthIds.push(authUser.user.id);

    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({ auth_user_id: authUser.user.id, email, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(profileError?.message);
    cleanupUserIds.push(profile.id);

    await admin.rpc("record_identity_link_failed", {
      p_user_id: profile.id,
      p_detail: { code: "link_failed" },
    });

    const { data: row } = await admin
      .from("account_events")
      .select("id")
      .eq("user_id", profile.id)
      .eq("event_type", "IDENTITY_LINK_FAILED")
      .single();

    const { error: updateError } = await admin
      .from("account_events")
      .update({ detail: { tampered: true } })
      .eq("id", row!.id);
    expect(updateError).not.toBeNull();
  });
});
