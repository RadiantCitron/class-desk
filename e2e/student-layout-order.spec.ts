import { test, expect } from "@playwright/test";
import {
  createCourseOffering,
  createTestUser,
  deleteCourseOffering,
  loginAs,
  retireTestUser,
} from "./helpers";

// U 단계 4 — 학생 페이지(/student) 섹션 순서: 수강 내역·내 혜택/내 정보 링크·
// 로그아웃이 페이지 위쪽, 개설 강의(신청 가능한 강의 목록)는 아래쪽.
test.describe("학생 페이지 섹션 순서", () => {
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;

  test.beforeEach(async ({ page }) => {
    student = await createTestUser({ role: "STUDENT", name: "홍길동", phone: "010-0000-0000" });
    ({ courseId, offeringId } = await createCourseOffering({}));
    await loginAs(page, student.email, student.password);
  });

  test.afterEach(async () => {
    if (student) await retireTestUser(student);
    if (offeringId && courseId) await deleteCourseOffering(offeringId, courseId);
  });

  test("내 수강 내역·내 혜택/내 정보·로그아웃이 개설 강의보다 위에 있다", async ({ page }) => {
    await page.goto("/student");
    const top = async (locator: ReturnType<typeof page.locator>) => {
      await expect(locator).toBeVisible();
      return (await locator.boundingBox())!.y;
    };

    const myEnrollments = await top(page.getByRole("heading", { name: "내 수강 내역" }));
    const benefitsLink = await top(page.getByRole("link", { name: "내 혜택" }));
    const profileLink = await top(page.getByRole("link", { name: "내 정보", exact: true }));
    const logout = await top(page.getByRole("button", { name: "로그아웃" }));
    const offerings = await top(page.getByRole("heading", { name: "개설 강의" }));

    expect(myEnrollments).toBeLessThan(offerings);
    expect(benefitsLink).toBeLessThan(offerings);
    expect(profileLink).toBeLessThan(offerings);
    expect(logout).toBeLessThan(offerings);
  });

  test("맨 위 제목은 '내 수강'이고 하단 링크 '내 정보'와 혼동되지 않는다", async ({ page }) => {
    await page.goto("/student");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("내 수강");
    await expect(page.getByRole("link", { name: "내 정보", exact: true })).toHaveCount(1);
  });
});
