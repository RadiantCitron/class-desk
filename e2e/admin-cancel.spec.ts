import { test, expect } from "@playwright/test";
import {
  createTestUser,
  retireTestUser,
  createCourseOffering,
  deleteCourseOffering,
  createPendingOrder,
  createApprovedOrder,
  loginAs,
  admin,
  reloadUntil,
} from "./helpers";

// "관리자 승인 → 취소" 경로를 실제 브라우저 클릭으로 수행한다.
test.describe("관리자 — 승인 후 취소", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let courseName: string;
  const capacity = 3;

  test.beforeEach(async ({ page }) => {
    adminUser = await createTestUser({ role: "ADMIN" });
    student = await createTestUser({ role: "STUDENT", name: "김학생", phone: "010-1111-2222" });
    ({ courseId, offeringId, courseName } = await createCourseOffering({ capacity }));
    await loginAs(page, adminUser.email, adminUser.password);
  });

  test.afterEach(async () => {
    await retireTestUser(adminUser);
    await retireTestUser(student);
    await deleteCourseOffering(offeringId, courseId);
  });

  test("PENDING을 승인하면 ENROLLED가 되고, 그 후 취소하면 CANCELLED로 바뀌고 좌석이 반환된다", async ({
    page,
  }) => {
    await createPendingOrder(student.id, offeringId, 50000);
    await admin.rpc("reserve_course_offering_seat", { p_offering_id: offeringId });

    await page.goto("/admin/orders");
    const row = page.locator("tbody tr", { hasText: courseName });
    await expect(row).toContainText("PENDING");

    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      row.getByRole("button", { name: "승인" }).click(),
    ]);
    await reloadUntil(page, () =>
      expect(page.locator("tbody tr", { hasText: courseName })).toContainText("APPROVED", { timeout: 5_000 }),
    );

    const cancelRow = page.locator("tbody tr", { hasText: courseName });
    await cancelRow.getByRole("button", { name: "취소" }).click();
    const cancelModal = page.getByRole("alertdialog", { name: "승인된 신청 취소" });
    await expect(cancelModal).toBeVisible();
    await cancelModal.locator('input[name="reason"]').fill("e2e 테스트 관리자 취소");
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      cancelModal.getByRole("button", { name: "취소 확정" }).click(),
    ]);
    await page.reload();
    await expect(page.locator("tbody tr", { hasText: courseName })).toContainText("CANCELLED");

    const { data: enrollment } = await admin
      .from("orders")
      .select("status")
      .eq("user_id", student.id)
      .eq("course_offering_id", offeringId)
      .single();
    expect(enrollment?.status).toBe("CANCELLED");

    const { data: offering } = await admin
      .from("course_offerings")
      .select("remaining_seats")
      .eq("id", offeringId)
      .single();
    expect(offering?.remaining_seats).toBe(capacity);
  });

  test("이미 결제된(PAID) 신청 건에는 취소 버튼 자체가 노출되지 않는다", async ({ page }) => {
    const enrollmentId = await createApprovedOrder(student.id, offeringId, 50000);
    await admin
      .from("orders")
      .update({ payment_status: "PAID", paid_at: new Date().toISOString(), payment_method: "CARD" })
      .eq("id", enrollmentId);

    await page.goto("/admin/orders");
    const row = page.locator("tbody tr", { hasText: courseName });
    await expect(row).toContainText("PAID");
    await expect(row.getByRole("button", { name: "취소" })).toHaveCount(0);
  });
});
