import { test, expect } from "@playwright/test";
import { createTestUser, retireTestUser, loginAs, admin } from "./helpers";

// 매니저 관리(/admin/managers) E2E:
// ADMIN 전용 페이지에서 기존 회원을 매니저로 승격·권한 수정·박탈하는 기능을 검증한다.
test.describe("관리자 — 매니저 관리", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let target: Awaited<ReturnType<typeof createTestUser>>;

  test.beforeEach(async ({ page }) => {
    adminUser = await createTestUser({ role: "ADMIN" });
    target = await createTestUser({ role: "STUDENT", name: "승격대상" });
    await loginAs(page, adminUser.email, adminUser.password);
  });

  test.afterEach(async () => {
    await retireTestUser(adminUser);
    await retireTestUser(target);
  });

  test("회원을 매니저로 승격하고 V-P가 표시된 뒤, 권한 수정과 박탈이 DB에 반영된다", async ({
    page,
  }) => {
    await page.goto("/admin/managers");

    // can_view_students 등은 "지정" 폼과 기존 매니저 각 행의 "수정" 폼에서 이름이 겹친다
    // (여러 매니저가 이미 있으면 locator가 모호해짐) — ManagerPanel이 항상 지정 폼을 목록보다
    // 먼저 렌더링하므로 페이지 안의 첫 번째 form으로 좁혀서 조작한다.
    const grantForm = page.locator("form").first();
    await grantForm.locator('input[name="email"]').fill(target.email);
    await grantForm.locator('input[name="can_view_students"]').check();
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      grantForm.getByRole("button", { name: "매니저로 지정" }).click(),
    ]);

    // 서버 컴포넌트라 재검증 후 다시 가야 최신 목록이 보인다.
    await page.goto("/admin/managers");
    const row = page.locator("tbody tr", { hasText: target.email });
    await expect(row).toBeVisible();
    await expect(row).toContainText("(V--)");

    const { data: afterGrant } = await admin
      .from("users")
      .select("role")
      .eq("id", target.id)
      .single();
    expect(afterGrant?.role).toBe("MANAGER");

    const { data: permsAfterGrant } = await admin
      .from("manager_permissions")
      .select("can_view_students, can_approve_orders, revoked_at")
      .eq("user_id", target.id)
      .single();
    expect(permsAfterGrant?.can_view_students).toBe(true);
    expect(permsAfterGrant?.can_approve_orders).toBe(false);
    expect(permsAfterGrant?.revoked_at).toBeNull();

    // 권한 수정: 승인 권한도 추가로 켠다.
    await row.locator('input[name="can_approve_orders"]').check();
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      row.getByRole("button", { name: "저장" }).click(),
    ]);

    const { data: permsAfterUpdate } = await admin
      .from("manager_permissions")
      .select("can_approve_orders")
      .eq("user_id", target.id)
      .single();
    expect(permsAfterUpdate?.can_approve_orders).toBe(true);

    // 박탈: role이 STUDENT로 되돌아가고 권한은 전부 false, revoked_at이 채워진다.
    await page.goto("/admin/managers");
    await page.locator("tbody tr", { hasText: target.email }).getByPlaceholder("박탈 사유").fill("E2E 박탈");
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      page
        .locator("tbody tr", { hasText: target.email })
        .getByRole("button", { name: "박탈" })
        .click(),
    ]);

    const { data: afterRevoke } = await admin
      .from("users")
      .select("role")
      .eq("id", target.id)
      .single();
    expect(afterRevoke?.role).toBe("STUDENT");

    const { data: permsAfterRevoke } = await admin
      .from("manager_permissions")
      .select("can_view_students, can_approve_orders, revoked_at")
      .eq("user_id", target.id)
      .single();
    expect(permsAfterRevoke?.can_view_students).toBe(false);
    expect(permsAfterRevoke?.can_approve_orders).toBe(false);
    expect(permsAfterRevoke?.revoked_at).not.toBeNull();

    // 감사로그에 세 조작 모두 남았는지 확인(전수조사에서 발견한 구멍이 아니라 매니저 CRUD
    // 자체는 runCommand(당시 runAdminCommand — CR-3에서 합쳐짐)를 통해 원래도 남게 설계됨 — 여기선 실제로 남는지만 확인).
    const { data: logs } = await admin
      .from("audit_logs")
      .select("action")
      .eq("target_id", target.id)
      .order("created_at", { ascending: true });
    expect(logs?.map((l) => l.action)).toEqual([
      "MANAGER_GRANT",
      "MANAGER_UPDATE",
      "MANAGER_REVOKE",
    ]);
  });

  test("가입하지 않은 이메일은 매니저로 지정할 수 없다", async ({ page }) => {
    const { count: before } = await admin
      .from("manager_permissions")
      .select("user_id", { count: "exact", head: true });

    await page.goto("/admin/managers");
    const grantForm = page.locator("form").first();

    await grantForm.locator('input[name="email"]').fill("no-such-email@example.com");
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      grantForm.getByRole("button", { name: "매니저로 지정" }).click(),
    ]);

    // 대상이 없으면 set_manager 자체가 안 불린다 — manager_permissions 행 개수가 그대로여야 한다
    // (다른 병행 테스트가 만들어 둔 매니저가 있을 수 있어 절대값 0이 아니라 증감으로 확인한다).
    const { count: after } = await admin
      .from("manager_permissions")
      .select("user_id", { count: "exact", head: true });
    expect(after ?? 0).toBe(before ?? 0);
  });
});
