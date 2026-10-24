import { test, expect } from "@playwright/test";
import { admin, createTestUser, loginAs, resetGates, retireTestUser, setActivePaymentProvider } from "./helpers";

// PG를 바꿀 때 ① 같은 값이면 저장 불가 안내 ② 저장 전 확인 모달에서 "A → B"를 보여 주고
// ③ 저장 뒤 결과 팝업이 무엇에서 무엇으로 바뀌었는지 알린다(페이앱 폐기 뒤에는 PG가 토스 하나라 TOSS ↔ 결제 차단으로 검증한다, 확인 버튼으로만 닫힘).
test.describe("관리자 결제 PG 변경 — 확인 모달과 결과 팝업", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;

  test.beforeEach(async ({ page }) => {
    await resetGates();
    adminUser = await createTestUser({ role: "ADMIN", name: "관리자" });
    await setActivePaymentProvider("TOSS", adminUser.id);
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto("/admin/system");
  });

  test.afterEach(async () => {
    if (adminUser) {
      await setActivePaymentProvider("TOSS", adminUser.id);
      await retireTestUser(adminUser);
    }
  });

  test("현재와 같은 PG를 고른 상태에서는 저장할 수 없다", async ({ page }) => {
    await expect(page.getByText("현재와 같은 값입니다")).toBeVisible();
    await expect(page.getByRole("button", { name: "PG 설정 저장" })).toBeDisabled();
  });

  test("TOSS → 결제 차단(미설정): 확인 모달에 변경 내용이 보이고, 저장하면 결과 팝업이 변경 내용을 알린다", async ({ page }) => {
    await page.getByRole("radio", { name: /미설정/ }).check();
    await expect(page.getByText("현재와 같은 값입니다")).toHaveCount(0);
    await page.getByRole("button", { name: "PG 설정 저장" }).click();

    const confirm = page.getByRole("alertdialog").filter({ hasText: "결제 PG를 변경할까요?" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("TOSS");
    await expect(confirm).toContainText("미설정(결제 차단)");
    // 확인 모달은 배경·ESC로는 닫히지 않는다.
    await page.mouse.click(2, 2);
    await page.keyboard.press("Escape");
    await expect(confirm).toBeVisible();

    await confirm.locator('textarea[name="reason"]').fill("R-6 e2e 변경");
    await confirm.getByRole("button", { name: "변경 확정" }).click();

    const popup = page.getByRole("alertdialog", { name: "✔ 처리되었습니다" });
    await expect(popup).toBeVisible({ timeout: 30_000 });
    await expect(popup).toContainText("TOSS → 미설정(결제 차단)");
    await expect(popup).toContainText("R-6 e2e 변경");
    await page.mouse.click(2, 2);
    await page.keyboard.press("Escape");
    await expect(popup).toBeVisible();
    await popup.getByRole("button", { name: "확인" }).click();
    await expect(popup).toHaveCount(0);

    const { data } = await admin.from("payment_settings").select("active_provider").single();
    expect(data?.active_provider).toBeNull();
    // 저장 뒤 같은 값이 선택된 채 남아 있으므로 다시 저장할 수 없다.
    await expect(page.getByRole("button", { name: "PG 설정 저장" })).toBeDisabled();
  });
});
