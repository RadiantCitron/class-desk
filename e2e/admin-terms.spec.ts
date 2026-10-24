import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createTestUser, retireTestUser, createCourseOffering, deleteCourseOffering, loginAs, admin } from "./helpers";

// "약관 체계" 재설계분: 새 버전 등록은 기존 버전을 수정하지 않고 append-only로
// 쌓이며, "현재 버전"은 항상 가장 최신(effective_at 기준)이고 새 신청부터 그 버전이 노출돼야
// 한다. 이건 화면 두 개(약관 관리 → 신청서)를 잇는 경로라 실제 클릭으로만 검증 가능하다.
test.describe("관리자 — 약관 새 버전 등록", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;

  test.beforeEach(async ({ page }) => {
    adminUser = await createTestUser({ role: "ADMIN" });
    await loginAs(page, adminUser.email, adminUser.password);
  });

  test.afterEach(async () => {
    await retireTestUser(adminUser);
  });

  test("같은 종류로 새 버전을 등록하면 '(현재 버전)' 배지가 새 버전으로 옮겨가고 구버전은 남는다", async ({
    page,
  }) => {
    const version = `SOFTWARE_LICENSE_USE_E2E_${randomUUID().slice(0, 8)}`;
    const content = `E2E 테스트 약관 전문 ${randomUUID().slice(0, 8)}`;

    await page.goto("/admin/terms");
    await page.locator('select[name="type"]').selectOption("SOFTWARE_LICENSE_USE");
    await page.locator('input[name="version"]').fill(version);
    await page.locator('textarea[name="content"]').fill(content);
    // 변경 사유는 필수 칸이다(비면 브라우저가 제출을 막는다).
    await page.locator('textarea[name="change_summary"]').fill("E2E 변경 사유");
    await page.getByRole("button", { name: "등록" }).click();

    await expect(page.getByText(version)).toBeVisible();
    const item = page.locator("li", { hasText: version });
    await expect(item).toContainText("(현재 버전)");
    await expect(item).toContainText(content);

    // 직전 최신판이었던 버전(시드 데이터)은 여전히 존재하되 "(현재 버전)" 배지는 없어야 한다.
    const { data: allVersions } = await admin
      .from("terms")
      .select("version")
      .eq("type", "SOFTWARE_LICENSE_USE")
      .order("effective_at", { ascending: false });
    expect(allVersions?.length ?? 0).toBeGreaterThan(1);
    expect(allVersions?.[0].version).toBe(version);
  });

  test("새 버전 등록 후 만든 개설강의의 신청서에는 새 버전의 본문이 그대로 노출된다", async ({
    page,
  }) => {
    const version = `AI_CROSS_BORDER_TRANSFER_E2E_${randomUUID().slice(0, 8)}`;
    const content = `국외이전 안내 최신본 ${randomUUID().slice(0, 8)}`;

    await page.goto("/admin/terms");
    await page.locator('select[name="type"]').selectOption("AI_CROSS_BORDER_TRANSFER");
    await page.locator('input[name="version"]').fill(version);
    await page.locator('textarea[name="content"]').fill(content);
    // 변경 사유는 필수 칸이다(비면 브라우저가 제출을 막는다).
    await page.locator('textarea[name="change_summary"]').fill("E2E 변경 사유");
    await page.getByRole("button", { name: "등록" }).click();
    await expect(page.getByText(version)).toBeVisible();

    const { offeringId, courseId, courseName } = await createCourseOffering({
      requiredTermsTypes: ["AI_CROSS_BORDER_TRANSFER"],
    });
    const student = await createTestUser({ role: "STUDENT", name: "박학생", phone: "010-2222-3333" });

    const studentPage = page.context();
    await studentPage.clearCookies();
    await loginAs(page, student.email, student.password);
    await page.goto(`/student/apply/${offeringId}`);

    await expect(page.getByText(version)).toBeVisible();
    await expect(page.getByText(content)).toBeVisible();

    await retireTestUser(student);
    await deleteCourseOffering(offeringId, courseId);
    void courseName;
  });
});
