import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import {
  createTestUser,
  retireTestUser,
  createCourseOffering,
  deleteCourseOffering,
  createApprovedOrder,
  loginAs,
  resetGates,
  resetUserSwitches,
  closeGate,
  clearSwitchViaUi,
  insertRailSwitch as insertSwitch,
  admin,
} from "./helpers";

// 명령 레일 검증 시나리오 — 기존 e2e(system-gates·student-restrictions·signup-gate)가 안 다루는 것
// 시스템 전체 봉쇄 중 관리자 통로·로그인, 모듈·조회 이름 단위 차단, 관리자 한 명만 차단, 거부 기록 모양, 공리 DB 제약, 다운로드 차단, 사실 처리.
// (2026-10-07 보강: 다른 관리자의 해제·다른 학생은 정상·열어 둔 화면의 명령 거부·크론/헬스체크·DISCORD_LINK 차단·감사 switchId)
// 스위치는 DB에 직접 걸고(준비), 화면 반응과 해제(통제실 통로)만 실제 화면으로 확인한다.
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

test.describe("명령 레일 검증 시나리오", () => {
  let student: TestUser;
  let adminUser: TestUser;
  let courseId: string;
  let offeringId: string;
  let enrollmentId: string;
  const price = 50_000;
  const extraUsers: TestUser[] = [];

  test.beforeEach(async () => {
    await resetGates();
    student = await createTestUser({ role: "STUDENT", name: "홍길동", phone: "010-0000-0000" });
    adminUser = await createTestUser({ role: "ADMIN" });
    ({ courseId, offeringId } = await createCourseOffering({ price, capacity: 3 }));
    enrollmentId = await createApprovedOrder(student.id, offeringId, price);
  });

  test.afterEach(async () => {
    await resetGates();
    for (const user of [student, adminUser, ...extraUsers]) await resetUserSwitches(user.id);
    await retireTestUser(student);
    await retireTestUser(adminUser);
    for (const user of extraUsers.splice(0)) await retireTestUser(user);
    await deleteCourseOffering(offeringId, courseId);
  });

  test("시스템 전체(전원) 봉쇄: 학생·관리자 화면은 막히고 로그인은 되며, 관리자는 스위치 화면에서 해제한다", async ({ page }) => {
    await closeGate("LOGIN", adminUser.id, "e2e 테스트 — 전체 점검"); // LOGIN 이름은 SYSTEM 전원 스위치로 이관된 것(로그인 자체는 막지 않는다)

    // 로그인은 된다(통제실 통로). 학생 화면은 막힌다.
    await loginAs(page, student.email, student.password);
    await page.goto("/student");
    await expect(page.getByText("이용 제한")).toBeVisible();
    await expect(page.getByText("서비스가 일시 중단되었습니다: e2e 테스트 — 전체 점검").first()).toBeVisible();
    await page.goto(`/student/payment/${enrollmentId}`);
    await expect(page.getByText("서비스가 일시 중단되었습니다: e2e 테스트 — 전체 점검").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "결제하기" })).toHaveCount(0);

    // 관리자도 막힌다(면제 없음) — 대시보드는 오류 화면, 그러나 통제실 통로(스위치 화면)는 열린다.
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto("/admin");
    await expect(page.getByText("문제가 생겼습니다")).toBeVisible();
    await page.goto("/admin/system");
    await expect(page.getByRole("heading", { name: "통제 스위치" })).toBeVisible();
    await expect(page.getByText("e2e 테스트 — 전체 점검").first()).toBeVisible();

    // 봉쇄 중에도 이 화면에서 해제할 수 있다(공리 RAIL_SWITCH_SET).
    await clearSwitchViaUi(page, "e2e 테스트 — 전체 점검", "e2e 해제");
    const { data: active } = await admin.from("rail_switches").select("id").eq("level", "SYSTEM").is("cleared_at", null);
    expect(active).toEqual([]);
    await page.goto("/admin");
    await expect(page.getByText("관리자 대시보드")).toBeVisible();
  });

  test("모듈(ORDER) 봉쇄: 학생 홈은 막히고 결제 모듈은 열려 있다", async ({ page }) => {
    await insertSwitch({ level: "MODULE", target: "ORDER", setBy: adminUser.id, reason: "e2e 테스트 — 주문 점검" });

    await loginAs(page, student.email, student.password);
    await page.goto("/student");
    await expect(page.getByText("이용 제한")).toBeVisible();
    await expect(page.getByText("주문 기능이 일시 중단되었습니다: e2e 테스트 — 주문 점검")).toBeVisible();

    await page.goto(`/student/payment/${enrollmentId}`);
    await expect(page.getByRole("button", { name: "결제하기" })).toBeVisible();
  });

  test("조회 이름 단위 봉쇄: 감사 로그 화면만 막히고 다른 관리자 화면은 열린다", async ({ page }) => {
    await insertSwitch({ level: "COMMAND", target: "ADMIN_AUDIT_LOGS_VIEW", setBy: adminUser.id, reason: "e2e 테스트 — 열람 금지" });

    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto("/admin/audit-logs");
    await expect(page.getByText("문제가 생겼습니다")).toBeVisible();
    await page.goto("/admin/dlq");
    await expect(page.getByText("문제가 생겼습니다")).toHaveCount(0);
  });

  test("유저별 봉쇄: 관리자 한 명(SYSTEM + 그 유저)만 막히고 다른 관리자는 정상, 막힌 관리자도 스위치 화면은 연다", async ({ page }) => {
    const blockedAdmin = await createTestUser({ role: "ADMIN" });
    extraUsers.push(blockedAdmin);
    await insertSwitch({ level: "SYSTEM", target: null, userId: blockedAdmin.id, setBy: adminUser.id, reason: "e2e 테스트 — 계정 정지" });

    await loginAs(page, blockedAdmin.email, blockedAdmin.password);
    await page.goto("/admin");
    await expect(page.getByText("문제가 생겼습니다")).toBeVisible();
    await page.goto("/admin/system");
    await expect(page.getByRole("heading", { name: "통제 스위치" })).toBeVisible();

    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto("/admin");
    await expect(page.getByText("관리자 대시보드")).toBeVisible();

    // 다른 관리자가 그 스위치를 스위치 화면에서 해제하면 막혔던 관리자의 화면이 다시 열린다(7절 2번).
    await clearSwitchViaUi(page, "e2e 테스트 — 계정 정지", "다른 관리자가 해제");
    await loginAs(page, blockedAdmin.email, blockedAdmin.password);
    await page.goto("/admin");
    await expect(page.getByText("관리자 대시보드")).toBeVisible();
  });

  test("기록: 거부는 기록(FAILED + 어느 층·스위치인지)되고, 통과한 조회는 기록되지 않는다(기본 OFF)", async ({ page }) => {
    const switchId = await insertSwitch({ level: "SYSTEM", target: null, setBy: adminUser.id, reason: "e2e 테스트 — 기록 확인" });
    await loginAs(page, student.email, student.password);
    await page.goto("/student");
    await expect(page.getByText("이용 제한")).toBeVisible();

    const { data: denied } = await admin
      .from("audit_logs")
      .select("phase, detail")
      .eq("actor_user_id", student.id)
      .eq("action", "STUDENT_HOME_VIEW");
    expect(denied?.length).toBeGreaterThanOrEqual(1);
    expect(denied?.every((row) => row.phase === "FAILED")).toBe(true);
    expect(denied?.[0].detail).toMatchObject({ rail_denied: { check: "SWITCH", layer: "SYSTEM", switchId } });

    await resetGates();
    await page.goto("/student");
    await expect(page.getByText("개설 강의")).toBeVisible();
    const { count } = await admin
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("actor_user_id", student.id)
      .eq("action", "STUDENT_HOME_VIEW");
    expect(count).toBe(denied?.length); // 통과한 조회는 새 행을 만들지 않는다
  });

  test("공리 DB 제약: 통제실 통로(RAIL_SWITCH_SET)·대상 있는 SYSTEM·알 수 없는 모듈 스위치는 DB가 거부한다", async () => {
    const base = { user_id: null, reason: "e2e 테스트", set_by: adminUser.id };
    const axiom = await admin.from("rail_switches").insert({ ...base, level: "COMMAND", target: "RAIL_SWITCH_SET" });
    expect(axiom.error).not.toBeNull();
    const systemWithTarget = await admin.from("rail_switches").insert({ ...base, level: "SYSTEM", target: "PAYMENT" });
    expect(systemWithTarget.error).not.toBeNull();
    const unknownModule = await admin.from("rail_switches").insert({ ...base, level: "MODULE", target: "BILLING" });
    expect(unknownModule.error).not.toBeNull();
  });

  test("다운로드 봉쇄(ENTITLEMENT_DOWNLOAD): 레일이 먼저 막고, 해제하면 일반 처리로 돌아간다", async ({ page }) => {
    await loginAs(page, student.email, student.password);
    const url = `/api/downloads/${randomUUID()}`;

    await insertSwitch({ level: "COMMAND", target: "ENTITLEMENT_DOWNLOAD", setBy: adminUser.id, reason: "e2e 테스트 — 자료 점검" });
    const blocked = await page.request.get(url);
    expect(blocked.status()).toBe(403);
    expect(await blocked.text()).toContain("자료 다운로드 기능이 일시 중단되었습니다: e2e 테스트 — 자료 점검");

    await resetGates();
    const open = await page.request.get(url);
    expect(open.status()).toBe(404); // 레일은 통과했고, 그런 이용권이 없을 뿐이다
  });

  test("사실 처리는 레일 밖: 시스템 전체 봉쇄 중에도 결제 웹훅 경로는 레일 문구로 막히지 않는다", async ({ request }) => {
    await insertSwitch({ level: "SYSTEM", target: null, setBy: adminUser.id, reason: "e2e 테스트 — 사실 처리" });
    // 서명 없는 빈 요청이라 웹훅 자체의 검증에서 거부되는 게 정상이다 — 확인하려는 것은 레일(일시 중단 문구)이 끼어들지 않는다는 점뿐이다.
    // (정상 웹훅이 봉쇄 중에도 기록되는 전체 흐름은 payment-toss.spec.ts의 「결제 게이트가 봉쇄돼 있어도 토스 웹훅은 정상 기록된다」가 본다.)
    const res = await request.post("/api/webhooks/payment/toss", { data: {} });
    expect(await res.text()).not.toContain("일시 중단");
  });

  test("유저별 결제 차단: 학생 A의 결제만 막히고 같은 강의를 신청한 학생 B는 정상이다", async ({ page }) => {
    const studentB = await createTestUser({ role: "STUDENT", name: "김철수", phone: "010-1111-1111" });
    extraUsers.push(studentB);
    const enrollmentB = await createApprovedOrder(studentB.id, offeringId, price);
    await insertSwitch({ level: "MODULE", target: "PAYMENT", userId: student.id, setBy: adminUser.id, reason: "e2e 테스트 — 결제 분쟁" });

    await loginAs(page, student.email, student.password);
    await page.goto(`/student/payment/${enrollmentId}`);
    await expect(page.getByText("관리자에 의해 결제 기능이 제한되었습니다: e2e 테스트 — 결제 분쟁")).toBeVisible();
    await expect(page.getByRole("button", { name: "결제하기" })).toHaveCount(0);

    await loginAs(page, studentB.email, studentB.password);
    await page.goto(`/student/payment/${enrollmentB}`);
    await expect(page.getByRole("button", { name: "결제하기" })).toBeVisible();
  });

  test("열어 둔 화면에서 명령이 막힌다: 모듈(ORDER) 봉쇄 뒤 과목 등록을 제출하면 거부되고 과목이 만들어지지 않는다", async ({ page }) => {
    const courseName = `E2E과목-${randomUUID().slice(0, 8)}`;
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto("/admin/courses");
    await page.getByPlaceholder("강의명").fill(courseName);

    // 화면은 이미 열려 있다 — 그 뒤에 봉쇄되면 서버(명령)가 거부해야 한다(기존 P-V2와 같은 패턴, 이번엔 주문 모듈의 명령 COURSE_CREATE).
    const switchId = await insertSwitch({ level: "MODULE", target: "ORDER", setBy: adminUser.id, reason: "e2e 테스트 — 주문 점검" });
    await page.getByRole("button", { name: "등록", exact: true }).click();
    await expect(page.getByText("주문 기능이 일시 중단되었습니다: e2e 테스트 — 주문 점검")).toBeVisible();

    const { data: created } = await admin.from("courses").select("id").eq("name", courseName);
    expect(created).toEqual([]);
    const { data: denied } = await admin
      .from("audit_logs")
      .select("phase, detail")
      .eq("actor_user_id", adminUser.id)
      .eq("action", "COURSE_CREATE")
      .eq("phase", "FAILED");
    expect(denied?.[0]?.detail).toMatchObject({ rail_denied: { check: "SWITCH", layer: "MODULE", switchId } });
  });

  test("사실 처리는 레일 밖: 시스템 전체 봉쇄 중에도 크론·헬스체크는 베어러 인증만으로 동작한다", async ({ request }) => {
    const secret = process.env.CRON_SECRET;
    expect(secret).toBeTruthy(); // .env.test의 e2e 전용 가짜 값(2026-10-07)
    await insertSwitch({ level: "SYSTEM", target: null, setBy: adminUser.id, reason: "e2e 테스트 — 크론 확인" });
    const auth = { authorization: `Bearer ${secret}` };

    // 원래의 보호는 그대로 — 인증 없이는 401.
    expect((await request.get("/api/cron/outbox")).status()).toBe(401);
    expect((await request.get("/api/health")).status()).toBe(401);

    // 인증하면 시스템 봉쇄와 상관없이 처리된다(레일 문구가 끼어들지 않는다).
    const cron = await request.get("/api/cron/outbox", { headers: auth });
    expect(cron.status()).toBe(200);
    expect(JSON.stringify(await cron.json())).not.toContain("일시 중단");
    const health = await request.get("/api/health", { headers: auth });
    expect(health.status()).toBe(200);
    expect((await health.json()).status).toBe("ok");
  });

  test("DISCORD_LINK 봉쇄(막힌 경우): 연결 버튼을 눌러도 디스코드로 넘어가지 않고 거부된다", async ({ page }) => {
    // 테스트 학생은 항상 디스코드가 연결된 채 만들어진다 — 이 학생만 연결을 지워 「디스코드 연결」 버튼이 보이게 한다.
    const { error: unlinkError } = await admin.from("discord_accounts").delete().eq("user_id", student.id);
    expect(unlinkError).toBeNull();
    await insertSwitch({ level: "COMMAND", target: "DISCORD_LINK", setBy: adminUser.id, reason: "e2e 테스트 — 연결 점검" });

    await loginAs(page, student.email, student.password);
    await page.goto("/student/profile");
    const origin = new URL(page.url()).origin;
    await page.getByRole("button", { name: "디스코드 연결" }).click();

    // 레일이 디스코드로 보내기 전에 거부한다 — 오류 화면, 주소는 우리 사이트 그대로, 연결 기록 없음.
    await expect(page.getByText("문제가 생겼습니다")).toBeVisible();
    expect(new URL(page.url()).origin).toBe(origin);
    const { data: account } = await admin.from("discord_accounts").select("user_id").eq("user_id", student.id);
    expect(account).toEqual([]);
    const { data: denied } = await admin
      .from("audit_logs")
      .select("phase, detail")
      .eq("actor_user_id", student.id)
      .eq("action", "DISCORD_LINK")
      .eq("phase", "FAILED");
    expect(denied?.[0]?.detail).toMatchObject({ rail_denied: { check: "SWITCH", layer: "COMMAND" } });
  });
});
