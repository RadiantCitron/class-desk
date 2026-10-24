import { test, expect } from "@playwright/test";
import { adminOnlyRoutePaths } from "@/lib/auth/permissions";
import {
  createTestUser,
  createTestManager,
  retireTestUser,
  createCourseOffering,
  deleteCourseOffering,
  createPendingOrder,
  loginAs,
  admin,
} from "./helpers";

// 매니저의 접근 범위(2026-09-18) — 권한에 따라 보이는 화면·칼럼·버튼이 달라지고, 권한 밖
// 경로는 막힌다. proxy.ts의 라우팅 차단과 화면 자체의 가드를 함께 확인한다.
test.describe("매니저 접근 범위", () => {
  // ADMIN_ROUTES(permission: null)와 같은 정본 — 하드코딩 중복 표는 /admin/system 누락 등 드리프트를
  // 낳는다(2026-09-27 라우팅 조사 후속).
  const ADMIN_ONLY_ROUTES = adminOnlyRoutePaths();

  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let courseName: string;

  test.beforeEach(async () => {
    student = await createTestUser({ role: "STUDENT", name: "매니저테스트대상" });
    ({ courseId, offeringId, courseName } = await createCourseOffering({ capacity: 3 }));
    await createPendingOrder(student.id, offeringId, 50000);
  });

  test.afterEach(async () => {
    await retireTestUser(student);
    await deleteCourseOffering(offeringId, courseId);
  });

  test("VIEW_STUDENTS만 있는 매니저는 수강생을 보되 승인 버튼은 없다", async ({ page }) => {
    const manager = await createTestManager({ viewStudents: true });
    await loginAs(page, manager.email, manager.password);

    await page.goto("/admin/orders");
    const row = page.locator("tbody tr", { hasText: courseName });
    await expect(row).toBeVisible();
    await expect(row).toContainText(student.email);
    await expect(row.getByRole("button", { name: "승인" })).toHaveCount(0);

    await page.goto("/admin/students");
    await expect(page.locator("tbody tr", { hasText: student.discordId })).toContainText(
      student.email,
    );

    await retireTestUser(manager);
  });

  test("APPROVE_ORDERS만 있는 매니저도 신청 목록에서 학생 이메일을 보고 승인할 수 있다", async ({
    page,
  }) => {
    const manager = await createTestManager({ approveOrders: true });
    await loginAs(page, manager.email, manager.password);

    await page.goto("/admin/orders");
    const row = page.locator("tbody tr", { hasText: courseName });
    await expect(row).toBeVisible();
    await expect(row).toContainText(student.email);

    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      row.getByRole("button", { name: "승인" }).click(),
    ]);

    const { data: enrollment } = await admin
      .from("orders")
      .select("id, status")
      .eq("user_id", student.id)
      .eq("course_offering_id", offeringId)
      .single();
    expect(enrollment?.status).toBe("APPROVED");

    // order_events.actor가 MANAGER로 기록되고, audit_logs에도 남는다.
    const { data: events } = await admin
      .from("order_events")
      .select("actor")
      .eq("order_id", enrollment!.id)
      .eq("event_type", "APPROVED")
      .single();
    expect(events?.actor).toBe("MANAGER");

    const { data: logs } = await admin
      .from("audit_logs")
      .select("action")
      .eq("actor_user_id", manager.id)
      .eq("action", "ORDER_APPROVE");
    expect(logs?.length).toBeGreaterThan(0);

    await retireTestUser(manager);
  });

  test("권한 없는 매니저는 관리자 전용 경로에 들어가면 /admin으로 돌려보내진다", async ({
    page,
  }) => {
    const manager = await createTestManager({});
    await loginAs(page, manager.email, manager.password);

    for (const route of ADMIN_ONLY_ROUTES) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/admin$/);
    }

    await retireTestUser(manager);
  });

  test("매니저가 /student로 가면 /admin으로 돌아온다(무한 루프 없이)", async ({ page }) => {
    const manager = await createTestManager({ viewStudents: true });
    await loginAs(page, manager.email, manager.password);

    await page.goto("/student");
    await expect(page).toHaveURL(/\/admin$/);

    await retireTestUser(manager);
  });

  test("박탈된 매니저는 /admin이 아니라 /student로 간다", async ({ page }) => {
    const manager = await createTestManager({ viewStudents: true, approveOrders: true });
    const { error } = await admin.rpc("revoke_manager", { p_target: manager.id, p_reason: "E2E 박탈", p_actor: manager.id });
    expect(error).toBeNull();

    await loginAs(page, manager.email, manager.password);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/student$/);

    await page.goto("/admin/orders");
    await expect(page).toHaveURL(/\/student$/);

    await retireTestUser(manager);
  });
});
