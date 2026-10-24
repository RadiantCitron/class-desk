import { describe, it, expect, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { loadProfileByAuthUserId } from "./identity";

// 통합 테스트 — 실제 로컬 Supabase가 떠 있어야 한다(`npm run db:start`).
// `npm run test`에서는 제외되고 `npm run test:integration`으로만 돈다.
//
// 이 파일은 2026-09-12 식별자 분리 작업 그 자체가 실제로 지켜지는지
// 증명한다 — supabase/tests/integrity_check.sql의 TEST16~19가 DB 레벨에서 같은 것을 검증하는
// 짝이다. 여기서는 TS 코드(identity.ts)가 실제 Supabase Auth API 호출 결과에 대해서도 같은
// 보장을 하는지를 본다(SQL 스크립트는 auth.users를 직접 delete하지만, 실제 프로덕션 경로는
// 항상 supabase.auth.admin.deleteUser()를 거치므로 그 경로를 그대로 재현한다).

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다. .env.local을 확인하고 " +
      "`npm run db:start`로 로컬 Supabase를 띄운 뒤 다시 실행하세요.",
  );
}

const admin = createClient(url, key, { auth: { persistSession: false } });

describe("식별자 분리 — 통합 테스트(로컬 Supabase 필요)", () => {
  let profileId: string | null = null;
  let authUserId: string | null = null;

  afterEach(async () => {
    // 탈퇴 정책은 테스트 코드도 예외가 아니다 — public.users는 소프트 탈퇴,
    // auth 계정만 실제 삭제한다.
    if (profileId) {
      await admin.from("users").update({ withdrawn_at: new Date().toISOString() }).eq("id", profileId);
      profileId = null;
    }
    if (authUserId) {
      await admin.auth.admin.deleteUser(authUserId);
      authUserId = null;
    }
  });

  it("public.users.id는 auth.users.id와 다른 값으로 독자 발급된다", async () => {
    const email = `vitest-identity-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(`테스트 계정 생성 실패: ${authError?.message}`);
    authUserId = authUser.user.id;

    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({ auth_user_id: authUserId, email, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(`프로필 생성 실패: ${profileError?.message}`);
    profileId = profile.id;

    expect(profile.id).not.toBe(authUserId);

    const loaded = await loadProfileByAuthUserId(admin, authUserId);
    expect(loaded?.id).toBe(profileId);
    expect(loaded?.authUserId).toBe(authUserId);
  });

  it("auth.admin.deleteUser()로 auth 계정을 지워도 public.users/enrollments가 살아남는다", async () => {
    const email = `vitest-identity-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(`테스트 계정 생성 실패: ${authError?.message}`);
    authUserId = authUser.user.id;

    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({ auth_user_id: authUserId, email, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(`프로필 생성 실패: ${profileError?.message}`);
    profileId = profile.id;

    // 이 테스트의 핵심: 이 작업 전에는 이 delete가 public.users.id로 cascade되어 프로필까지
    // 실제로 사라졌다(20260909120000_init_schema.sql의 on delete cascade). 지금은 auth_user_id가
    // FK 없이 독립된 컬럼이라 영향이 없어야 한다.
    const { error: deleteError } = await admin.auth.admin.deleteUser(authUserId);
    expect(deleteError).toBeNull();
    authUserId = null; // 이미 지워졌으니 afterEach가 다시 지우지 않게 한다.

    const { data: survivingProfile, error: selectError } = await admin
      .from("users")
      .select("id, withdrawn_at")
      .eq("id", profileId)
      .maybeSingle();

    expect(selectError).toBeNull();
    expect(survivingProfile).not.toBeNull();
    expect(survivingProfile?.id).toBe(profileId);
    // 삭제 자체를 감지하는 부수 효과가 없어야 한다 — auth 계정 삭제는 withdrawn_at을 건드리지
    // 않는다(탈퇴는 오직 app/student/profile/actions.ts의 withdraw()를 통해서만 일어난다).
    expect(survivingProfile?.withdrawn_at).toBeNull();
  });

  it("public.users 행을 직접 delete하면 거부된다(service_role은 REVOKE에, 소유자는 트리거에 막힘)", async () => {
    const email = `vitest-identity-${randomUUID()}@example.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(`테스트 계정 생성 실패: ${authError?.message}`);
    authUserId = authUser.user.id;

    const { data: profile, error: profileError } = await admin
      .from("users")
      .insert({ auth_user_id: authUserId, email, role: "STUDENT" })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(`프로필 생성 실패: ${profileError?.message}`);
    profileId = profile.id;

    const { error: deleteError } = await admin.from("users").delete().eq("id", profileId);

    // 이 admin 클라이언트는 SERVICE_ROLE_KEY로 인증한 service_role이다(createAdminClient()가
    // 실제로 쓰는 것과 같은 경로) — 삭제 차단 마이그레이션의 REVOKE DELETE가 트리거보다 먼저
    // 걸려 42501(insufficient_privilege)로 막힌다. supabase/tests/integrity_check.sql의
    // TEST17은 `psql`로 postgres 슈퍼유저(테이블 소유자)로 접속해 실행하므로 REVOKE를
    // 우회하고 트리거까지 도달해 23001(restrict_violation)을 받는다 — 두 코드 모두 같은
    // "하드 삭제 원천 차단" 목적의 서로 다른 방어선이 각자 맡은 경로에서 작동한다는 증거다
    // ("REVOKE만으로는 테이블 소유자를 막지 못한다"의 반대쪽 증명).
    expect(deleteError).not.toBeNull();
    expect(deleteError?.code).toBe("42501");

    const { data: stillThere } = await admin.from("users").select("id").eq("id", profileId).maybeSingle();
    expect(stillThere).not.toBeNull();
  });
});
