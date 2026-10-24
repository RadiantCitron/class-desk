import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/supabase/relations";
import { resolvePermissions, type Permissions, type Role } from "@/lib/auth/permissions";

// 이 시스템에는 사용자를 가리키는 id가 두 개 있다. 이 파일이 그 둘 사이의 유일한 다리다.
//   - Profile.id        = public.users.id — 우리 업무 데이터(orders/payment_events/
//                          entitlements/...)의 user_id로 쓰는 값. DB에 뭔가를 쓸 때는 항상 이것.
//   - Profile.authUserId = auth.users.id  — Supabase 인증 계정 id(로그인 세션 식별용).
//                          우리 테이블 어느 컬럼에도 절대 넣지 않는다.
// 'auth_user_id'라는 컬럼명이 등장해도 되는 유일한 TS 파일이다(lib/supabase/middleware.ts
// 제외 — 거기는 세션 자체를 얻는 곳이지 프로필을 조회하는 곳은 아니다).
// 왜 이렇게 분리했는지, 무엇이 문제였는지는 /27절 참고.
export type Profile = {
  id: string;
  authUserId: string;
  role: Role;
  discordId: string | null;
  email: string;
  withdrawnAt: string | null;
  // 매니저 권한 3종(2026-09-18). ADMIN은 항상 전부 true, STUDENT는 항상 전부 false다.
  // 계산 근거는 DB의 has_permission()이며, 여기 값은 화면 표시·앱 가드용 캐시일 뿐이다
  // (실제 데이터 접근권한은 여전히 RLS의 has_permission() 호출이 최종 방어선).
  permissions: Permissions;
  // 약관 재동의 필요 시 배열이 담기고, 동의가 완료되었으면 null이다.
  pendingTerms: { terms_id: string; type: string; version: string; content: string; change_summary: string | null }[] | null;
};

// discord_id는 2026-09-27부터 users에 없다 — discord_accounts(이용권 모듈 소유)를 조인해 읽는다.
const PROFILE_COLUMNS = "id, auth_user_id, role, email, withdrawn_at, discord_accounts(discord_id)";

type ProfileRow = {
  id: string;
  auth_user_id: string;
  role: Role;
  email: string;
  withdrawn_at: string | null;
  discord_accounts: { discord_id: string } | { discord_id: string }[] | null;
};

type ManagerPermissionsRow = {
  can_view_students: boolean;
  can_approve_orders: boolean;
  can_approve_payments: boolean;
  revoked_at: string | null;
};

// proxy.ts는 next/headers의 cookies()를 쓸 수 없고 자기 request 기반 클라이언트
// (lib/supabase/middleware.ts의 updateSession())를 따로 들고 있다. 그래서 클라이언트를
// 주입받는 형태를 노출한다 — 'auth_user_id' 컬럼 지식은 그래도 이 파일에만 있다.

// 동의해야 할 필수 약관. 캐시하지 않는다 — 예전 Next 데이터 캐시(태그만 있고 무효화 호출 0건)는
// 새 약관 게시·동의 직후에도 옛 결과를 무기한 돌려줄 수 있었다. 요청당 RPC 1회는
// 1인 운영 규모에서 부담이 없고, 무효화 장치를 따로 두는 것보다 단순하다. get_pending_terms는 service_role 전용이다.
async function loadPendingTerms(userId: string): Promise<Profile["pendingTerms"]> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_pending_terms", { p_user_id: userId });
  if (error) {
    console.error("Failed to fetch pending terms:", error);
    return null;
  }
  return data && data.length > 0 ? data : null;
}

export async function loadProfileByAuthUserId(
  supabase: SupabaseClient,
  authUserId: string,
): Promise<Profile | null> {
  const { data } = await supabase
    .from("users")
    .select(PROFILE_COLUMNS)
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (!data) return null;
  const row = data as ProfileRow;

  // MANAGER일 때만 권한 행을 추가로 조회한다(ADMIN/STUDENT는 role만으로 전부/전무가 정해짐).
  // manager_permissions RLS가 "본인 권한만 조회 가능"을 이미 강제하므로 세션 클라이언트로 충분하다.
  let permRow: ManagerPermissionsRow | null = null;
  if (row.role === "MANAGER") {
    const { data: perm } = await supabase
      .from("manager_permissions")
      .select("can_view_students, can_approve_orders, can_approve_payments, revoked_at")
      .eq("user_id", row.id)
      .is("revoked_at", null)
      .maybeSingle();
    permRow = perm as ManagerPermissionsRow | null;
  }

  const pendingTerms = await loadPendingTerms(row.id);

  return {
    id: row.id,
    authUserId: row.auth_user_id,
    role: row.role,
    discordId: one(row.discord_accounts)?.discord_id ?? null,
    email: row.email,
    withdrawnAt: row.withdrawn_at,
    permissions: resolvePermissions(
      row.role,
      permRow && {
        canViewStudents: permRow.can_view_students,
        canApproveOrders: permRow.can_approve_orders,
        canApprovePayments: permRow.can_approve_payments,
        revokedAt: permRow.revoked_at,
      },
    ),
    pendingTerms,
  };
}

// app/page.tsx(세션은 있지만 아직 가입 전이라 프로필이 없는 경우를 구분해야 함)와
// app/terms/actions.ts(디스코드 identities/email 원본이 필요함)처럼, Profile로 변환하기 전의
// 원본 auth 사용자가 꼭 필요한 극소수 지점을 위한 탈출구다. 이 파일이 auth.getUser()를 호출하는
// 유일한 지점이 되도록 여기 모아둔다(identity.guard.test.ts가 이걸 강제한다) — 그 외 코드는
// 항상 getCurrentProfile()을 우선 써야 한다(비로그인·탈퇴·권한 판정은 명령 레일 runCommand/runQuery가 한다 — CR-6에서 requireProfile 삭제).
export async function getCurrentAuthUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

// 라우트 핸들러처럼 이미 만든 Supabase 클라이언트로 세션→프로필을 읽는다.
// auth.getUser()는 여기(와 middleware)에만 둔다(identity.guard).
export async function loadProfileFromAuthClient(
  supabase: Parameters<typeof loadProfileByAuthUserId>[0],
): Promise<Profile | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return loadProfileByAuthUserId(supabase, user.id);
}

// React cache()로 요청 1건 안에서 중복 호출을 합친다 — auth.getUser()는 매번 Supabase Auth
// 서버를 때리므로(lib/supabase/middleware.ts:30-31 주석 참고), 페이지+서버액션에서 여러 번
// 부르면 그대로 왕복 횟수가 된다.
export const getCurrentProfile = cache(async (): Promise<Profile | null> => {
  const { supabase, user } = await getCurrentAuthUser();
  if (!user) return null;
  return loadProfileByAuthUserId(supabase, user.id);
});

// 가입 링크를 보내기 전, 그 이메일로 미리 만들어진 "미인증" 인증 계정의 비밀번호를 무작위 값으로
// 덮어써 무력화한다. 우리 화면에 비밀번호 입력이 없어도, anon 키로
// supabase.auth.signUp()을 직접 부르는 경로는 항상 열려 있어 공격자가 비밀번호를 미리 심어 둘 수
// 있다 — 나중에 signInWithPassword()를 API로 직접 불러 계정을 탈취하는 걸 막는다. 이미 인증된
// 계정이면 "이미 가입된 이메일"을 알린다. auth_user_id 값을 다루므로 이 파일에 둔다
// (identity.guard.test.ts).
export async function neutralizePlantedPassword(email: string): Promise<"NONE" | "UNCONFIRMED" | "CONFIRMED"> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("auth_account_state_by_email", { p_email: email });
  if (error) throw new Error(`가입 상태 확인 실패: ${error.message}`);
  const row = (data as { auth_user_id: string; email_confirmed: boolean }[] | null)?.[0];
  if (!row) return "NONE";
  if (row.email_confirmed) return "CONFIRMED";
  const { randomUUID } = await import("crypto");
  const { error: updateError } = await admin.auth.admin.updateUserById(row.auth_user_id, {
    password: `${randomUUID()}A1`,
  });
  if (updateError) throw new Error(`가입 준비 실패: ${updateError.message}`);
  return "UNCONFIRMED";
}

// 가입 마무리 시점의 2차 무력화. 피해자가 가입 링크를 요청한 "뒤에" 공격자가
// signUp(password)을 불러 비밀번호를 심는 순서(로컬 재현 T1b)까지 막는다 — 링크를 이미 눌러 이메일
// 주인임이 증명된 이 계정의 비밀번호를 무작위 값으로 덮어쓴다. 비밀번호 로그인은 지금 없으므로
// 정상 회원에게는 아무 영향이 없다.
export async function scrambleAuthPassword(authUserId: string): Promise<void> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { randomUUID } = await import("crypto");
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(authUserId, { password: `${randomUUID()}A1` });
  if (error) throw new Error(`가입 마무리 준비 실패: ${error.message}`);
}

// 가입 마무리 시 2차 무력화 — admin.updateUserById(password)는 현재 매직링크 세션까지 무효화하므로,
// 이미 열린 세션의 updateUser로 공격자가 심은 비밀번호만 덮어쓴다.
export async function scrambleAuthPasswordInSession(supabase: SupabaseClient): Promise<void> {
  const { randomUUID } = await import("crypto");
  const { error } = await supabase.auth.updateUser({ password: `${randomUUID()}A1` });
  if (error) throw new Error(`가입 마무리 준비 실패: ${error.message}`);
}
