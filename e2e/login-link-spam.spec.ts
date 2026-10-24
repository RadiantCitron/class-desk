import { test, expect } from "@playwright/test";
import { createTestUser, retireTestUser } from "./helpers";

// Mailpit 메일함 헬퍼 — e2e/signup-login.spec.ts의 mailCount()와 동일한 구현이다(그 파일을
// 고치지 않기 위해 이 파일에 복제한다, R-NOSCOPE — 적히지 않은 파일은 건드리지 않는다).
async function mailCount(email: string): Promise<number> {
  const list = await (await fetch("http://127.0.0.1:54324/api/v1/messages")).json();
  return (list.messages ?? []).filter((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === email))
    .length;
}

test.describe("로그인 링크 연타 — 서버 멱등 없음 확인", () => {
  test.setTimeout(60_000);

  test("로그인 링크 요청 버튼을 두 번 누르면 메일이 두 통 간다(현재 동작 그대로 확인 — 고치지 않는다)", async ({
    page,
  }) => {
    const user = await createTestUser({ role: "STUDENT" });

    try {
      const before = await mailCount(user.email);

      await page.goto("/login");
      await page.getByPlaceholder("이메일").fill(user.email);
      await page.getByRole("button", { name: "로그인 링크 받기" }).click();
      await expect.poll(async () => mailCount(user.email), { timeout: 15_000 }).toBeGreaterThanOrEqual(before + 1);

      // 같은 주소로 바로 다시 누르면 GoTrue가 429(over_email_send_rate_limit)를 주고,
      // 화면은 그 오류를 "가입되지 않은 이메일"로 보여 성공 문구가 안 뜬다.
      // 한 탭 연타가 아니라 발송이 끝난 뒤 다시 요청한다.
      await page.waitForTimeout(2_000);
      await page.goto("/login");
      await page.getByPlaceholder("이메일").fill(user.email);
      await page.getByRole("button", { name: "로그인 링크 받기" }).click();

      await expect
        .poll(async () => mailCount(user.email), { timeout: 15_000 })
        .toBeGreaterThanOrEqual(before + 2);
    } finally {
      await retireTestUser(user);
    }
  });
});
