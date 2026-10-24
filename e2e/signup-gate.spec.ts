import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { admin, closeGate, createTestUser, resetGates, retireTestUser } from "./helpers";

test.describe("시스템 봉쇄 — SIGNUP", () => {
  test.afterEach(async () => {
    await resetGates();
  });

  test("SIGNUP 게이트가 CLOSED면 가입 링크 요청이 거부된다", async ({ page }) => {
    // 명령 레일 CR-2: 가입 봉쇄 = 통제 스위치 COMMAND ACCOUNT_SIGNUP(전원). 사유·설정자 필수.
    const actor = await createTestUser({ role: "ADMIN" });
    const { error } = await closeGate("SIGNUP", actor.id, "e2e 테스트");
    expect(error).toBeNull();

    const email = `e2e-signup-blocked-${randomUUID()}@example.com`;
    await page.goto("/signup");
    await page.getByPlaceholder("이메일").fill(email);
    // 필수 약관 2개에 동의해야 제출된다(가입 전 약관 동의). 안 체크하면 브라우저가 제출을 막는다.
    await page.getByRole("checkbox", { name: "이용약관에 동의합니다." }).check();
    await page.getByRole("checkbox", { name: "개인정보 수집 및 이용에 동의합니다." }).check();
    await page.getByRole("button", { name: "가입 링크 받기" }).click();

    await expect(page.getByText(/회원가입 기능이 일시 중단되었습니다/)).toBeVisible();

    // 실제로 가입 절차가 진행되지 않았는지(auth 계정이 안 만들어졌는지) 확인.
    const { data: users } = await admin.auth.admin.listUsers();
    expect(users.users.some((u) => u.email === email)).toBe(false);
    await retireTestUser(actor);
  });
});
