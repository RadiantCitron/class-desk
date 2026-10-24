import { test, expect } from "@playwright/test";
import {
  admin,
  createApprovedOrder,
  createCourseOffering,
  createTestUser,
  deleteCourseOffering,
  loginAs,
  resetGates,
  retireTestUser,
} from "./helpers";

// 학생 "내 정보" 화면: 폐강 진행·완료 개설강의, 취소·반려된 주문에는 "결제하기" 링크를 보이지 않는다
// (결제하기 버튼 자체가 비활성화되어야 한다). 실제 결제 시작 차단은 서버 규칙이 이미 한다.
test.describe("학생 목록 결제하기 링크(A3)", () => {
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let courseName: string;
  let orderId: string;

  test.beforeEach(async ({ page }) => {
    await resetGates();
    student = await createTestUser({ role: "STUDENT", name: "홍길동", phone: "010-1111-2222" });
    ({ courseId, offeringId, courseName } = await createCourseOffering({ price: 20_000 }));
    orderId = await createApprovedOrder(student.id, offeringId, 20_000);
    await loginAs(page, student.email, student.password);
  });

  test.afterEach(async () => {
    if (student) await retireTestUser(student);
    if (offeringId && courseId) await deleteCourseOffering(offeringId, courseId);
  });

  const row = (page: import("@playwright/test").Page) =>
    page.locator("tbody tr", { hasText: courseName });

  test("정상(모집 중·승인된 미결제) 주문에는 결제하기 링크가 있다", async ({ page }) => {
    await page.goto("/student");
    await expect(row(page).getByRole("link", { name: "결제하기" })).toBeVisible();
  });

  test("폐강 진행 중 개설강의의 미결제 주문에는 링크 대신 결제 불가가 보이고 상단 결제 안내에도 없다", async ({
    page,
  }) => {
    const { error } = await admin
      .from("course_offerings")
      .update({
        status: "CANCELLING",
        // 상태 전이 트리거가 사유·행위자·변경 시각을 요구한다(enforce_status_transition_reason).
        status_reason: "e2e A3",
        status_changed_by: student.id,
        status_changed_at: new Date().toISOString(),
      })
      .eq("id", offeringId);
    if (error) throw new Error(`개설강의 상태 변경 실패: ${error.message}`);

    await page.goto("/student");
    await expect(row(page)).toBeVisible();
    await expect(row(page).getByRole("link", { name: "결제하기" })).toHaveCount(0);
    await expect(row(page)).toContainText("결제 불가");
    await expect(page.getByText("승인된 신청이 있습니다")).toHaveCount(0);
  });

  test("반려된 미결제 주문에는 결제하기 링크가 없다", async ({ page }) => {
    const { error } = await admin
      .from("orders")
      .update({ status: "REJECTED", approved_at: null }) // orders_status_consistency: REJECTED는 approved_at이 없어야 한다
      .eq("id", orderId);
    if (error) throw new Error(`주문 상태 변경 실패: ${error.message}`);

    await page.goto("/student");
    await expect(row(page)).toBeVisible();
    await expect(row(page).getByRole("link", { name: "결제하기" })).toHaveCount(0);
    await expect(row(page)).toContainText("결제 불가");
  });
});
