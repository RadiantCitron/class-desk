import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import {
  createTestUser,
  retireTestUser,
  createCourseOffering,
  deleteCourseOffering,
  createApprovedOrder,
  loginAs,
  admin,
  closeTestOrder,
} from "./helpers";

// discount_rules 삭제가 실제 DELETE(ON DELETE SET NULL 유발)에서 소프트 삭제
// (deleted_at)로 바뀌었다("DB에서 삭제는 없다" 원칙의 카탈로그성 데이터 확대 적용).
// 이제 행 자체가 사라지지 않으므로 discount_rule_id는 SET NULL로 끊기지 않고 그대로 남는다 —
// final_amount는 원래도 스냅샷이라 보존되고, discount_rule_id도 "그때 어떤 할인을 썼는지"
// 계속 추적 가능해졌다(과거보다 더 나아진 지점). 목록 화면에서 삭제한 규정이 안 보이는 것만
// 학생/관리자 UX 관점의 "삭제"이고, DB 레벨에선 항상 조회 가능하다는 걸 이 테스트가 확인한다.
test.describe("관리자 — 수강료 산정기준(할인) CRUD", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;

  test.beforeEach(async ({ page }) => {
    adminUser = await createTestUser({ role: "ADMIN" });
    await loginAs(page, adminUser.email, adminUser.password);
  });

  test.afterEach(async () => {
    await retireTestUser(adminUser);
  });

  test("정률(%) 산정기준을 등록하면 목록에 %로 표시된다", async ({ page }) => {
    const name = `E2E정률-${randomUUID().slice(0, 8)}`;
    await page.goto("/admin/discount-rules");
    await page.getByPlaceholder(/이름/).fill(name);
    await page.locator('select[name="discount_type"]').selectOption("PERCENT");
    await page.locator('input[name="discount_value"]').fill("20");
    await page.getByRole("button", { name: "등록" }).click();

    const row = page.locator("tbody tr", { hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("20%");

    await row.getByPlaceholder("삭제 사유").fill("E2E 정리");
    await row.getByRole("button", { name: "삭제" }).click();
    await expect(page.locator("tbody tr", { hasText: name })).toHaveCount(0);
  });

  test("정액(원) 산정기준을 등록하면 목록에 '원'으로 천단위 구분되어 표시된다", async ({ page }) => {
    const name = `E2E정액-${randomUUID().slice(0, 8)}`;
    await page.goto("/admin/discount-rules");
    await page.getByPlaceholder(/이름/).fill(name);
    await page.locator('select[name="discount_type"]').selectOption("FIXED");
    await page.locator('input[name="discount_value"]').fill("15000");
    await page.getByRole("button", { name: "등록" }).click();

    const row = page.locator("tbody tr", { hasText: name });
    await expect(row).toContainText("15,000원");

    await row.getByPlaceholder("삭제 사유").fill("E2E 정리");
    await row.getByRole("button", { name: "삭제" }).click();
    await expect(page.locator("tbody tr", { hasText: name })).toHaveCount(0);
  });

  test("이미 신청건이 참조 중인 산정기준도 화면에서 숨길(소프트 삭제) 수 있고, 참조와 final_amount는 보존된다", async ({
    page,
  }) => {
    const name = `E2E참조중-${randomUUID().slice(0, 8)}`;
    const { data: rule } = await admin
      .from("discount_rules")
      .insert({ name, discount_type: "PERCENT", discount_value: 10 })
      .select("id")
      .single();

    const student = await createTestUser({ role: "STUDENT" });
    const { courseId, offeringId, courseName } = await createCourseOffering();
    const enrollmentId = await createApprovedOrder(student.id, offeringId, 50000);
    await admin
      .from("orders")
      .update({ discount_rule_id: rule!.id, final_amount: 45000 })
      .eq("id", enrollmentId);

    await page.goto("/admin/discount-rules");
    const row = page.locator("tbody tr", { hasText: name });
    await expect(row).toBeVisible();
    await row.getByPlaceholder("삭제 사유").fill("E2E 정리");
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      row.getByRole("button", { name: "삭제" }).click(),
    ]);
    await page.reload();
    await expect(page.locator("tbody tr", { hasText: name })).toHaveCount(0);

    const { data: enrollment } = await admin
      .from("orders")
      .select("discount_rule_id, final_amount")
      .eq("id", enrollmentId)
      .single();
    // 소프트 삭제라 행 자체는 그대로 있다 — discount_rule_id도 안 끊기고 남는다(SET NULL 없음).
    expect(enrollment?.discount_rule_id).toBe(rule!.id);
    expect(enrollment?.final_amount).toBe(45000); // 스냅샷이므로 규정을 숨겨도 금액은 그대로

    const { data: hiddenRule } = await admin
      .from("discount_rules")
      .select("id, deleted_at")
      .eq("id", rule!.id)
      .single();
    expect(hiddenRule?.deleted_at).not.toBeNull(); // 실제로는 안 지워지고 숨김 처리만 됨을 확인.

    // 신청은 지우지 않고 취소로 닫는다.
    await closeTestOrder(enrollmentId, adminUser.id);
    await retireTestUser(student);
    await deleteCourseOffering(offeringId, courseId);
    await admin.from("discount_rules").delete().eq("id", rule!.id);
    void courseName;
  });
});
