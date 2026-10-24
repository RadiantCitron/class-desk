import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { expect, type Page } from "@playwright/test";

// e2e 테스트 전용 fixture 헬퍼. service_role로 직접 DB에 데이터를 만들고 치운다 — DB 상태를
// 준비하는 것과 화면이 그 상태를 올바르게 보여주는지 확인하는 것을 분리한다(전자는 이미
// supabase/tests/integrity_check.sql이 검증하므로 여기서 다시 검증하지 않는다).
export const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

export type TestUser = {
  id: string; // public.users.id (profile id) — orders/entitlements 등 업무 데이터는 이걸 쓴다
  authUserId: string; // auth.users.id (세션 계정 id) — auth.admin.* 호출에만 쓴다
  email: string;
  password: string;
  discordId: string;
};

// 로컬 Supabase DB 컨테이너 이름(docker-compose가 붙이는 고정 이름 동일).
const DB_CONTAINER = "supabase_db_class-desk";

// ADMIN은 이제 앱 경로(service_role 포함)로 부여할 수 없다(users_guard_admin_role 트리거,
// supabase/migrations/20260918100000_manager_permissions.sql — "ADMIN은 내가 쿼리로 DB에
// 직접 넣는다, 다른 방법은 없다" 원칙을 테스트도 예외 없이 따른다, 2026-09-18). 그래서
// STUDENT로 만든 뒤 psql(슈퍼유저 postgres)로 직접 승격한다 — 이것이 실제 운영 절차
//와 똑같은 경로다.
function promoteToAdminViaSql(email: string) {
  execFileSync("docker", [
    "exec",
    DB_CONTAINER,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-c",
    `update public.users set role = 'ADMIN' where email = '${email}';`,
  ]);
}

// 관리자 폼의 datetime-local 값(한국 시간)을 "지금으로부터 days일 뒤"로 만든다. 고정 날짜는 시간이 지나면
// 개강·잠금 판정이 바뀌어 테스트가 썩는다(2026-10-07).
export function kstLocalInput(days: number): string {
  return new Date(Date.now() + days * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 16);
}

// 개설 폼의 날짜 입력은 달력(SessionPicker)이다. 「YYYY-MM-DD」 한국 날짜를 지금으로부터 days일 뒤로 만든다.
export function kstDateInput(days: number): string {
  return kstLocalInput(days).slice(0, 10);
}

/**
 * 개설 폼의 달력에서 날짜를 고른다 — 기본 시각을 정하고, 요일 반복 채우기(요일 체크 + 기간 + 채우기)를 눌러 선택에 더한다.
 * days는 0=일 … 6=토. 이미 열린 폼(/admin/course-offerings)에서 호출한다.
 */
export async function fillSessionPicker(
  page: import("@playwright/test").Page,
  opts: { from: string; until: string; days: number[]; start: string; end: string },
) {
  const picker = page.getByTestId("session-picker");
  await picker.getByTestId("base-start").fill(opts.start);
  await picker.getByTestId("base-end").fill(opts.end);
  // 요일을 안 주면 하루짜리(from = until)로 보고 그 날짜의 요일을 채운다.
  const days = opts.days.length > 0 ? opts.days : [new Date(`${opts.from}T00:00:00Z`).getUTCDay()];
  for (const d of days) await picker.getByTestId(`fill-day-${d}`).check();
  await picker.getByTestId("fill-from").fill(opts.from);
  await picker.getByTestId("fill-until").fill(opts.until);
  await picker.getByTestId("fill-button").click();
}

export async function createTestUser(opts: {
  role: "STUDENT" | "ADMIN";
  name?: string;
  phone?: string;
}): Promise<TestUser> {
  const email = `e2e-${randomUUID()}@example.com`;
  const password = "e2e-test-password-1234";
  const discordId = `e2e-${randomUUID()}`;

  const { data: authUser, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError || !authUser.user) throw new Error(`테스트 계정 생성 실패: ${authError?.message}`);

  // public.users.id는 이제 auth.users.id와 독립적으로 발급된다(2026-09-12 식별자 분리)
  // — auth_user_id 컬럼으로 연결하고, DB가 발급한 id를 그대로 받는다.
  // ADMIN을 바로 넣지 않고 항상 STUDENT로 만든 뒤(아래에서 필요하면 SQL로 승격) — 트리거가
  // service_role의 ADMIN insert 자체를 거부하기 때문이다.
  const { data: profile, error: profileError } = await admin
    .from("users")
    .insert({
      auth_user_id: authUser.user.id,
      email,
      role: "STUDENT",
      name: opts.name ?? null,
      phone: opts.phone ?? null,
    })
    .select("id")
    .single();
  if (profileError || !profile) throw new Error(`프로필 생성 실패: ${profileError?.message}`);

  // discord_id는 2026-09-27부터 users가 아니라 discord_accounts(이용권 모듈)에 있다.
  const { error: discordError } = await admin
    .from("discord_accounts")
    .insert({ user_id: profile.id, discord_id: discordId });
  if (discordError) throw new Error(`디스코드 연결 생성 실패: ${discordError.message}`);

  if (opts.role === "ADMIN") {
    promoteToAdminViaSql(email);
  }

  // 가입 시 SERVICE_USE+PRIVACY_USE, 신청·결제 시 THIRD_PARTY_SHARE(실 PG) 동의가 필요하다.
  // createApprovedOrder 등은 신청 UI를 건너뛰므로 여기서 제3자 제공 동의까지 심는다.
  for (const type of ["SERVICE_USE", "PRIVACY_USE", "THIRD_PARTY_SHARE"]) {
    const { data: terms } = await admin
      .from("terms")
      .select("id")
      .eq("type", type)
      .order("effective_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (terms) {
      await admin.from("terms_agreements").insert({ user_id: profile.id, terms_id: terms.id });
    }
  }

  return { id: profile.id, authUserId: authUser.user.id, email, password, discordId };
}

// MANAGER 테스트 계정(2026-09-18). STUDENT로 가입시킨 뒤 set_manager() RPC(service_role —
// 정상 앱 경로와 동일, ADMIN과 달리 트리거에 막히지 않는다)로 권한을 부여한다. granted_by는
// 실제 ADMIN일 필요가 없어(set_manager()는 행위자 role을 검사하지 않는다) 본인 id를 그대로 쓴다.
export async function createTestManager(perms: {
  viewStudents?: boolean;
  approveOrders?: boolean;
  approvePayments?: boolean;
}): Promise<TestUser> {
  const user = await createTestUser({ role: "STUDENT" });

  const { error } = await admin.rpc("set_manager", {
    p_target: user.id,
    p_actor: user.id,
    p_view: perms.viewStudents ?? false,
    p_approve: perms.approveOrders ?? false,
    p_pay: perms.approvePayments ?? false,
  });
  if (error) throw new Error(`테스트 매니저 지정 실패: ${error.message}`);

  return user;
}

// 예전엔 deleteTestUser()가 public.users 행을 하드 삭제했다 — 2026-09-12 삭제 차단 트리거
// (forbid_users_delete(), supabase/migrations/20260912130100_forbid_users_hard_delete.sql) 도입
// 이후로는 그 자체가 불가능해졌고, 애초에 "탈퇴는 소프트 삭제만" 원칙에 테스트
// 코드도 예외가 아니어야 한다("테스트도 지우지 않게 바꿈"). auth 계정만
// 실제로 삭제한다 — 이 함수가 매 테스트마다 정상 동작한다는 것 자체가 "auth를 지워도 업무
// 데이터는 멀쩡하다"는 이번 작업의 목적을 상시 증명한다.
export async function retireTestUser(user: Pick<TestUser, "id" | "authUserId">) {
  await admin.from("users").update({ withdrawn_at: new Date().toISOString() }).eq("id", user.id);
  await admin.auth.admin.deleteUser(user.authUserId);
}

export async function createCourseOffering(
  opts: { price?: number; capacity?: number; requiredTermsTypes?: string[] } = {},
) {
  const courseName = `E2E강의-${randomUUID().slice(0, 8)}`;
  const { data: course } = await admin
    .from("courses")
    .insert({ name: courseName, category: "IT" })
    .select("id")
    .single();

  const { data: offering } = await admin
    .from("course_offerings")
    .insert({
      course_id: course!.id,
      label: "E2E기",
      capacity: opts.capacity ?? 5,
      remaining_seats: opts.capacity ?? 5,
      price: opts.price ?? 50000,
      // 신청 가능 = 모집 시작 ≤ 지금 < 개강
      recruit_opens_at: new Date(Date.now() - 3_600_000).toISOString(),
      opens_at: new Date(Date.now() + 86_400_000).toISOString(),
      ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      status: "OPEN",
      required_terms_types: opts.requiredTermsTypes ?? [],
    })
    .select("id")
    .single();

  return { courseId: course!.id, offeringId: offering!.id, courseName };
}

export async function deleteCourseOffering(offeringId: string, courseId: string) {
  try {
    execFileSync("docker", [
      "exec",
      DB_CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      `delete from public.course_sessions where course_offering_id = '${offeringId}';
       delete from public.course_offering_events where course_offering_id = '${offeringId}';`,
    ]);
  } catch {}
  await admin.from("course_offerings").delete().eq("id", offeringId);
  await admin.from("courses").delete().eq("id", courseId);
}

// 관리자 승인까지 마친 상태를 직접 만든다 — apply/approve 자체는 apply.spec.ts가 따로 검증하므로,
// 여기선 "이미 승인된 신청건"을 전제로 하는 화면(결제 등)만 집중해서 본다.
export async function createApprovedOrder(userId: string, offeringId: string, price: number) {
  const { data } = await admin
    .from("orders")
    .insert({
      user_id: userId,
      course_offering_id: offeringId,
      status: "APPROVED",
      approved_at: new Date().toISOString(),
      list_price: price,
      final_amount: price,
    })
    .select("id")
    .single();
  return data!.id as string;
}

// 테스트가 만든 미결제 주문을 지우지 않고 종료 상태로 닫는다(테스트도 주문·원장·상품은 지우지 않는다, 잔여는 db:reset).
// 앱과 같은 transition_order 경로: PENDING → REJECTED, APPROVED(미결제) → CANCELLED. 이미 종료된 주문은 그대로 둔다.
// 닫아 두면 오래 방치된 신청 대사 경고(7일 PENDING·14일 APPROVED 미결제)가 다음 실행마다 생기지 않는다.
// 좌석 반환은 함수 안에서 정원을 넘지 않게만 된다(createPendingOrder처럼 좌석을 안 줄인 주문이어도 안전).
export async function closeTestOrder(orderId: string, adminProfileId: string) {
  const { data: order } = await admin.from("orders").select("status, payment_status").eq("id", orderId).single();
  const next =
    order?.status === "PENDING"
      ? "REJECTED"
      : order?.status === "APPROVED" && order.payment_status === "UNPAID"
        ? "CANCELLED"
        : null;
  if (!next) return;
  const { error } = await admin.rpc("transition_order", {
    p_order_id: orderId,
    p_actor_id: adminProfileId,
    p_actor_role: "ADMIN",
    p_event_type: next,
    p_next_status: next,
    p_reason: "테스트 종료 정리",
  });
  if (error) throw new Error(`테스트 주문 정리(${next}) 실패: ${error.message}`);
}

export async function createPendingOrder(userId: string, offeringId: string, price: number) {
  const { data } = await admin
    .from("orders")
    .insert({
      user_id: userId,
      course_offering_id: offeringId,
      list_price: price,
      final_amount: price,
    })
    .select("id")
    .single();
  return data!.id as string;
}

// 시스템 봉쇄 스위치는 전역 상태다 — 이 저장소의 e2e는 이미
// fullyParallel:false + workers:1로 전 spec을 순차 실행하지만(playwright.config.ts), 이전
// 테스트가 실패로 중단돼 스위치를 걸어 둔 채 남기면 그 뒤에 도는 모든 spec이 영향을 받는다.
// 명령 레일 CR-2(2026-10-07)부터 봉쇄·학생 제한 상태는 통제 스위치(rail_switches)다 — 삭제가 금지돼 있어
// "초기화"는 활성 행을 해제(cleared_*)로 기록하는 것이다. 해제 행위자는 그 스위치를 건 사람으로 적는다.
async function clearActiveSwitches(filter: { userId: string | null }) {
  let query = admin.from("rail_switches").select("id, set_by").is("cleared_at", null);
  query = filter.userId === null ? query.is("user_id", null) : query.eq("user_id", filter.userId);
  const { data } = await query;
  for (const row of data ?? []) {
    await admin
      .from("rail_switches")
      .update({ cleared_at: new Date().toISOString(), cleared_by: row.set_by, cleared_reason: "e2e 초기화" })
      .eq("id", row.id);
  }
}

// 전원 대상 스위치 전부 해제(옛 게이트 PAYMENT/SIGNUP/LOGIN 포함).
export async function resetGates() {
  await clearActiveSwitches({ userId: null });
}

// 그 유저 대상 스위치 전부 해제(옛 학생 3축 제한 포함).
export async function resetUserSwitches(userId: string) {
  await clearActiveSwitches({ userId });
}

// e2e가 옛 게이트 이름(PAYMENT/SIGNUP/LOGIN)으로 부르는 시나리오의 스위치 대응 — 명령 레일 CR-2의 이관표와 같다.
// (앱의 번역표 LEGACY_GATE_SWITCH는 CR-7에서 지웠다. LOGIN은 공리라 스위치 대상이 될 수 없어 SYSTEM 전원으로 옮겼다.)
const GATE_SWITCH_KEYS = {
  PAYMENT: { level: "MODULE", target: "PAYMENT" },
  SIGNUP: { level: "COMMAND", target: "ACCOUNT_SIGNUP" },
  LOGIN: { level: "SYSTEM", target: null },
} as const;
type LegacyGateCode = keyof typeof GATE_SWITCH_KEYS;

// 옛 게이트 이름으로 전원 대상 스위치를 DB에 직접 건다(관리자 화면을 거치지 않는 준비용).
export async function closeGate(code: LegacyGateCode, actorId: string, reason: string) {
  const { error } = await admin
    .from("rail_switches")
    .insert({ ...GATE_SWITCH_KEYS[code], user_id: null, reason, set_by: actorId });
  return { error };
}

// 통제 스위치를 DB에 직접 건다(관리자 화면을 거치지 않는 준비용) — 새 스위치 행의 id를 돌려준다. 해제는 resetGates·resetUserSwitches가 한다.
export async function insertRailSwitch(input: {
  level: "SYSTEM" | "MODULE" | "COMMAND";
  target: string | null;
  userId?: string | null;
  setBy: string;
  reason: string;
}): Promise<string> {
  const { data, error } = await admin
    .from("rail_switches")
    .insert({ level: input.level, target: input.target, user_id: input.userId ?? null, reason: input.reason, set_by: input.setBy })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id as string;
}

// 스위치 화면(/admin/system)에서 스위치를 설정한다 — 관리자로 로그인한 page가 필요하다.
// target은 화면 선택지의 값(모듈 이름 또는 명령 이름)이고 SYSTEM이면 생략한다. userEmail을 비우면 전원 대상이다.
export async function setSwitchViaUi(
  page: Page,
  input: { level: "SYSTEM" | "MODULE" | "COMMAND"; target?: string; userEmail?: string; reason: string },
) {
  await page.goto("/admin/system");
  await page.getByRole("button", { name: "스위치 설정" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.locator('select[name="level"]').selectOption(input.level);
  if (input.target) await dialog.locator('select[name="target"]').selectOption(input.target);
  if (input.userEmail) await dialog.locator('input[name="userEmail"]').fill(input.userEmail);
  await dialog.locator('textarea[name="reason"]').fill(input.reason);
  await Promise.all([
    page.waitForResponse((res) => res.request().method() === "POST"),
    dialog.getByRole("button", { name: "설정 확정" }).click(),
  ]);
  // 결과 팝업(성공)을 확인 버튼으로 닫는다.
  const result = page.getByRole("alertdialog");
  await expect(result).toContainText("스위치를 설정했습니다");
  await result.getByRole("button", { name: "확인" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
}

// 스위치 화면에서 활성 스위치 한 줄을 해제한다. rowText는 그 줄을 찾는 글자(설정 사유처럼 유일한 값)다.
export async function clearSwitchViaUi(page: Page, rowText: string, reason: string) {
  await page.goto("/admin/system");
  const row = page.locator("tbody tr", { hasText: rowText }).first();
  await row.getByPlaceholder("해제 사유").fill(reason);
  await Promise.all([
    page.waitForResponse((res) => res.request().method() === "POST"),
    row.getByRole("button", { name: "해제" }).click(),
  ]);
}

// 옛 게이트 이름으로 전원 대상 스위치가 걸려 있는지(걸려 있으면 사유).
export async function gateSwitch(code: LegacyGateCode): Promise<{ closed: boolean; reason: string | null }> {
  const key = GATE_SWITCH_KEYS[code];
  let query = admin.from("rail_switches").select("reason").eq("level", key.level).is("user_id", null).is("cleared_at", null);
  query = key.target === null ? query.is("target", null) : query.eq("target", key.target);
  const { data } = await query.maybeSingle();
  return { closed: Boolean(data), reason: data?.reason ?? null };
}

// 학생 본인 세션(anon 키 + 로그인 JWT)으로 PostgREST를 직접 두드리는 클라이언트.
// 브라우저에 실제로 존재하는 것과 같은 권한이므로, "화면에 안 보인다"가 아니라 "API로도
// 못 가져간다"를 검증할 때 쓴다 — DOM만 보는 단언은 RLS 구멍을 구조적으로 못 잡는다
// (2026-09-23 진단: 반려 사유가 orders 행에 있어 학생이 직접 조회 가능했다 — 3단계에서
// 반려 사유 자체를 없앴다).
export async function createStudentApiClient(user: Pick<TestUser, "email" | "password">) {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error) throw new Error(`학생 세션 클라이언트 로그인 실패: ${error.message}`);
  return client;
}

export async function loginAs(page: Page, email: string, password: string) {
  const res = await page.request.post("/api/test/login", { data: { email, password } });
  if (!res.ok()) throw new Error(`테스트 로그인 실패: ${await res.text()}`);
}

// INTEGRITY 대사가 DLQ에 남긴 미해결 항목 개수 — expect.poll 등 e2e 폴링용.
export async function countIntegrityDlq(orderId: string, check: string): Promise<number> {
  const { count, error } = await admin
    .from("dead_letters")
    .select("id", { count: "exact", head: true })
    .eq("source", "INTEGRITY")
    .eq("resolved", false)
    .contains("payload", { order_id: orderId, check });
  if (error) throw new Error(`DLQ 조회 실패: ${error.message}`);
  return count ?? 0;
}

// /admin 대시보드의 "아웃박스 지금 처리" — 서버 액션 POST가 끝날 때까지 기다린다.
export async function triggerAdminOutboxDrain(page: Page) {
  await page.goto("/admin");
  const drainButton = page.getByRole("button", { name: "아웃박스 지금 처리" });
  await Promise.all([
    page.waitForResponse((res) => res.request().method() === "POST" && res.ok()),
    drainButton.click(),
  ]);
}

/** payment_settings.active_provider 설정(service_role RPC). */
export async function setActivePaymentProvider(
  provider: "TOSS" | null,
  actorId: string,
  reason = "e2e PG-7",
) {
  const { error } = await admin.rpc("set_payment_provider", {
    p_active_provider: provider,
    p_reason: reason,
    p_actor_id: actorId,
  });
  if (error) throw new Error(`PG 설정 실패: ${error.message}`);
}

/** G1 작업 3 — since 이후 해당 주문 관련 새 DLQ가 0건인지. */
export async function expectNoNewDlqForOrder(orderId: string, since: Date) {
  const { data, error } = await admin
    .from("dead_letters")
    .select("id, error_message, payload, created_at")
    .gte("created_at", since.toISOString());
  if (error) throw new Error(`DLQ 조회 실패: ${error.message}`);
  const hits = (data ?? []).filter((r) => {
    if (typeof r.error_message === "string" && r.error_message.includes(orderId)) return true;
    const payload = r.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return (payload as Record<string, unknown>).order_id === orderId;
    }
    return false;
  });
  if (hits.length !== 0) {
    throw new Error(`새 DLQ ${hits.length}건: ${JSON.stringify(hits)}`);
  }
}

export function appBaseUrl() {
  return (process.env.APP_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
}

export function fakePgOrigin() {
  return (process.env.TOSS_API_BASE_URL || "http://127.0.0.1:4010/toss").replace(/\/toss$/, "");
}

export async function waitOrderPaymentStatus(
  orderId: string,
  status: string,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await admin
      .from("orders")
      .select("payment_status, status, refunded_amount, paid_at")
      .eq("id", orderId)
      .single();
    if (data?.payment_status === status) return data;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`주문 ${orderId}이 ${timeoutMs}ms 안에 payment_status=${status}가 되지 않음`);
}


/**
 * 서버 액션(승인·반려 등) 직후 화면 반영을 확인한다 — 새로고침과 단언을 함께 재시도한다.
 * 액션 응답 직후 곧바로 page.reload()를 부르면 액션 뒤에 이어지는 화면 갱신과 겹쳐
 * "Protocol error (Page.reload): Not attached to an active page"로 가끔 실패했다(서버 패닉은 없음).
 */
export async function reloadUntil(page: Page, check: () => Promise<void>, timeoutMs = 30_000) {
  await expect(async () => {
    await page.reload();
    await check();
  }).toPass({ timeout: timeoutMs });
}

// 토스(가짜 PG) 결제 성공 한 건 — 결제하기 → 가짜 토스 결제창 "성공" → 복귀. payment-toss·admin-refund-ui 스펙 공용.
// 결제 페이지의 "결제하기"를 눌러 가짜 토스 결제창(오버레이)을 열고, 그 안의 결제 진행 버튼을 누른다(= 실제 토스의 "결제하기").
// 중간 이동 페이지 제거 — 결제창은 결제 페이지 위에 뜨고, 결제 시도는 이 진행 버튼을 누를 때 만들어진다.
export async function startPaymentInFakeToss(page: Page) {
  await page.getByRole("button", { name: "결제하기", exact: true }).click();
  await page.getByRole("button", { name: "카드로 결제 진행(가짜 토스)" }).click();
}

export async function payWithTossSuccess(page: Page, orderId: string) {
  await page.goto(`/student/payment/${orderId}`);
  await startPaymentInFakeToss(page);
  await page.waitForURL(new RegExp("4010/toss/checkout|/toss/checkout"), { timeout: 45_000 });
  await page.getByRole("button", { name: "성공" }).click();
  // 승인 성공이면 복귀 라우트가 수강 조회(/student?paid=1)로 보낸다(2026-10-02).
  await page.waitForURL(/\/student\?paid=1/, { timeout: 60_000 });
}

export async function tossPaymentKey(orderId: string) {
  const { data } = await admin
    .from("payment_events")
    .select("provider_transaction_id")
    .eq("order_id", orderId)
    .eq("event_type", "PAYMENT_SUCCEEDED")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.provider_transaction_id) throw new Error("TOSS paymentKey 없음");
  return data.provider_transaction_id as string;
}

// 토스 웹훅 수동 트리거 — 서버는 본문을 믿지 않고 가짜 토스에 결제를 다시 조회해 사실을 만든다(G3 수동 트리거와 같은 방식).
export async function triggerTossWebhook(paymentKey: string) {
  const res = await fetch(`${appBaseUrl()}/api/webhooks/payment/toss`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventType: "PAYMENT_STATUS_CHANGED", data: { paymentKey } }),
  });
  if (!res.ok) throw new Error(`토스 웹훅 트리거 실패: ${res.status}`);
}
