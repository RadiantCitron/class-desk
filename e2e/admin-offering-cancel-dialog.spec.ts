import { test, expect } from "@playwright/test";
import {
  createCourseOffering,
  createTestUser,
  deleteCourseOffering,
  loginAs,
  retireTestUser,
} from "./helpers";

// 폐강 확인창에 "어떤 과목을 폐강하는지"가 보여야 한다.
test.describe("개설강의 폐강 확인창(A2)", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let courseName: string;

  test.beforeEach(async ({ page }) => {
    adminUser = await createTestUser({ role: "ADMIN", name: "관리자" });
    ({ courseId, offeringId, courseName } = await createCourseOffering({}));
    await loginAs(page, adminUser.email, adminUser.password);
  });

  test.afterEach(async () => {
    if (adminUser) await retireTestUser(adminUser);
    if (offeringId && courseId) await deleteCourseOffering(offeringId, courseId);
  });

  test("폐강 확인창에 과목명과 회차가 보인다(폐강은 실행하지 않는다)", async ({ page }) => {
    await page.goto("/admin/course-offerings");
    const row = page.locator("tbody tr", { hasText: courseName });
    const dialog = page.getByRole("alertdialog").filter({ hasText: "개설강의를 폐강할까요?" });
    // 페이지가 아직 준비(hydration)되기 전에 누르면 모달이 안 열리므로, 열릴 때까지 누르기를 재시도한다.
    await expect(async () => {
      await row.getByRole("button", { name: "폐강", exact: true }).click();
      await expect(dialog).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(dialog).toContainText(`폐강 대상: ${courseName} (E2E기)`);
  });

  test("폐강을 확정하면 결과 팝업이 \"시작\"임을 알리고, 마무리 확인 뒤 \"완료\" 팝업이 뜬다(U 단계 3)", async ({ page }) => {
    await page.goto("/admin/course-offerings");
    const row = page.locator("tbody tr", { hasText: courseName });
    const dialog = page.getByRole("alertdialog").filter({ hasText: "개설강의를 폐강할까요?" });
    await expect(async () => {
      await row.getByRole("button", { name: "폐강", exact: true }).click();
      await expect(dialog).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await dialog.locator('input[name="reason"]').fill("e2e 폐강 팝업 확인");
    await dialog.getByRole("button", { name: "폐강 확정" }).click();

    // 폐강 "시작" 접수 팝업 — 완료가 아니다. 입력 모달은 닫힌다.
    const started = page.getByRole("alertdialog", { name: "✔ 처리되었습니다" });
    await expect(started).toBeVisible({ timeout: 30_000 });
    await expect(started).toContainText("폐강을 시작했습니다");
    await expect(started).toContainText("마무리 확인");
    await expect(dialog).toHaveCount(0);
    await started.getByRole("button", { name: "확인" }).click();
    await expect(started).toHaveCount(0);

    // 신청이 없으니 곧바로 마무리할 수 있다 — 완료 팝업.
    await expect(row).toContainText("폐강중");
    await row.getByRole("button", { name: "폐강 마무리 확인" }).click();
    const completed = page.getByRole("alertdialog", { name: "✔ 처리되었습니다" });
    await expect(completed).toBeVisible({ timeout: 30_000 });
    await expect(completed).toContainText("폐강을 완료했습니다");
    await completed.getByRole("button", { name: "확인" }).click();
    await expect(row).toContainText("폐강완료");
  });
});
