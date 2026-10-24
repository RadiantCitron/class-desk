import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { admin } from "./helpers";

// (2026-09-25 재설계) — 이메일 매직링크 가입·로그인·탈퇴·복구를 실제 화면으로 검증한다.
// 비밀번호를 전혀 쓰지 않는다. 링크는 로컬 메일 수신함(Mailpit, http://127.0.0.1:54324)에서 읽는다.
async function mailCount(email: string): Promise<number> {
  const list = await (await fetch("http://127.0.0.1:54324/api/v1/messages")).json();
  return (list.messages ?? []).filter((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === email)).length;
}

// 그 주소로 온 메일이 before개보다 늘 때까지 기다린 뒤 가장 최근 메일(목록은 최신순)의 링크를 꺼낸다 —
// 이미 쓴 옛 메일의 링크를 집지 않게 한다. HTML 속 링크는 &가 &amp;로 적혀 있어 되돌린다.
async function nextConfirmationUrl(email: string, before: number): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch("http://127.0.0.1:54324/api/v1/messages")).json();
    const mine = (list.messages ?? []).filter((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === email));
    if (mine.length > before) {
      const full = await (await fetch(`http://127.0.0.1:54324/api/v1/message/${mine[0].ID}`)).json();
      const href = String(full.HTML ?? "").match(/href="([^"]+)"/);
      const raw = href ? href[1] : (String(full.Text ?? "").match(/https?:\/\/\S+/) ?? [])[0];
      if (raw) return raw.replace(/&amp;/g, "&");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`새 메일을 찾지 못함: ${email}`);
}

test.describe("회원 — 가입·로그인·탈퇴·복구 (매직링크)", () => {
  test.setTimeout(120_000);

  test("이메일 링크로 가입 → 약관 동의, 로그아웃 후 다시 링크로 로그인, 탈퇴 후 같은 계정으로 복구", async ({ page }) => {
    const email = `e2e-signup-${randomUUID()}@example.com`;

    await page.goto("/signup");
    let before = await mailCount(email);
    await page.getByPlaceholder("이메일").fill(email);
    // 필수 약관 2개에 동의해야 제출된다(가입 전 약관 동의). 안 체크하면 브라우저가 제출을 막는다.
    await page.getByRole("checkbox", { name: "이용약관에 동의합니다." }).check();
    await page.getByRole("checkbox", { name: "개인정보 수집 및 이용에 동의합니다." }).check();
    await page.getByRole("button", { name: "가입 링크 받기" }).click();
    await expect(page.getByText(email)).toBeVisible();

    // token_hash 방식이라 요청한 브라우저가 아니어도 열린다 —
    // 이 테스트는 같은 컨텍스트에서 열지만, 다른 기기에서 여는 경우는 아래 별도 테스트에서 확인한다.
    // 가입 폼에서 이미 필수 약관에 동의했으므로 링크를 누르면 약관 화면 없이 바로 가입이 끝난다(/auth/confirm 자동 가입 —
    // 명령 ACCOUNT_SIGNUP, app/signup/finish-signup.ts). 예전에는 여기서 /signup/complete 약관 화면을 거쳤다.
    await page.goto(await nextConfirmationUrl(email, before));
    await expect(page).toHaveURL(/\/student\?welcome=1/);
    // 학생 홈이 열렸고 디스코드는 아직 연결되지 않았다(연결 안내 문구는 열려 있는 온라인 수업이 DB에 있을 때만 뜨므로 단언하지 않는다 —
    // 연결 여부는 아래 discord_accounts 확인이 본다).
    await expect(page.getByRole("heading", { name: "내 수강", level: 1 })).toBeVisible();
    await expect(page.getByText("디스코드 ID:")).toHaveCount(0);

    const { data: user } = await admin.from("users").select("id, withdrawn_at").eq("email", email).single();
    // discord_id는 2026-09-27부터 users가 아니라 discord_accounts에 있다 — 아직 연결 안 했으니
    // 그 테이블에 이 회원 행 자체가 없어야 한다.
    const { data: discordAccount } = await admin
      .from("discord_accounts")
      .select("discord_id")
      .eq("user_id", user!.id)
      .maybeSingle();
    expect(discordAccount).toBeNull();
    const { count: signedUp } = await admin
      .from("account_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user!.id)
      .eq("event_type", "SIGNED_UP");
    expect(signedUp).toBe(1);

    // 로그아웃 → 다시 로그인(새 매직링크)
    await page.context().clearCookies();
    await page.goto("/login");
    before = await mailCount(email);
    await page.getByPlaceholder("이메일").fill(email);
    await page.getByRole("button", { name: "로그인 링크 받기" }).click();
    await expect(page.getByText(email)).toBeVisible();

    await page.goto(await nextConfirmationUrl(email, before));
    await expect(page).toHaveURL(/\/student/);

    // 탈퇴 → 다시 로그인하면 복구 화면 → 복구 → 같은 id
    await page.goto("/student/profile");
    await page.getByPlaceholder("본인 이메일 입력").fill(email);
    await page.getByRole("button", { name: "탈퇴하기" }).click();
    await expect(page).toHaveURL("/withdrawn");

    await page.context().clearCookies();
    await page.goto("/login");
    before = await mailCount(email);
    await page.getByPlaceholder("이메일").fill(email);
    await page.getByRole("button", { name: "로그인 링크 받기" }).click();
    await expect(page.getByText(email)).toBeVisible();
    await page.goto(await nextConfirmationUrl(email, before));
    await expect(page).toHaveURL(/\/reactivate/);
    for (const box of await page.locator('input[type="checkbox"]').all()) {
      await box.check();
    }
    await page.getByRole("button", { name: "계정 복구" }).click();
    await expect(page).toHaveURL(/\/student/);

    const { data: after } = await admin.from("users").select("id, withdrawn_at").eq("email", email).single();
    expect(after?.id).toBe(user!.id);
    expect(after?.withdrawn_at).toBeNull();
  });

  // "매직링크는 이메일로만 로그인한다. 휴대폰도
  // 가능하면 기능구현만 하고 실제 테스트는 미룬다." 실제 휴대폰 테스트는 미루되, "다른 기기에서
  // 열어도 로그인된다"는 기능 자체는 로컬에서 확인한다: 링크를 요청한 것과 다른 브라우저
  // 컨텍스트(쿠키 없음 = 다른 기기 흉내)에서 열어 로그인이 되는지 본다. PKCE(?code=)였다면 이
  // 컨텍스트에 code_verifier 쿠키가 없어 실패했을 것이다 — token_hash 방식이라 성공해야 한다.
  test("만료·잘못된 매직링크는 auth_failed를 보여주고, 미가입 완료 계정은 로그인 링크 후 약관 화면으로 간다", async ({
    page,
  }) => {
    const email = `e2e-expired-${randomUUID()}@example.com`;

    // "회원 행이 없는 인증 계정" — 가입 폼(약관 동의 신호 pending_agreements가 실린다)은 이제 링크를 누르면 바로 가입이 끝나므로,
    // 약관 동의 신호 없이 인증 계정만 만든 뒤(예: 가입 폼 밖에서 만들어진 계정) 그 계정의 매직링크를 한 번 열어 세션만 만든다.
    const { error: createError } = await admin.auth.admin.createUser({ email, email_confirm: true });
    expect(createError).toBeNull();
    const { data: generated, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    expect(linkError).toBeNull();
    await page.goto(`/auth/confirm?token_hash=${generated!.properties!.hashed_token}&type=magiclink`);
    await expect(page).toHaveURL(/\/signup\/complete/);
    await page.context().clearCookies();

    // 만료·재사용 실패 흉내 — verifyOtp가 거부하면 auth_failed로 돌아온다.
    await page.goto("/auth/confirm?token_hash=invalid-expired-token&type=signup");
    await expect(page).toHaveURL(/\/login\?error=auth_failed/);
    await expect(page.getByText("인증에 실패했습니다. 다시 로그인해 주세요.")).toBeVisible();

    const before = await mailCount(email);
    // 위 generateLink가 이 계정의 링크 발송 시각을 남겼고, 로컬 인증의 [auth.email] max_frequency = "1s" 안에 다시 요청하면
    // 429(over_email_send_rate_limit)다. 서버가 빠르면 그 안에 들어가 버리므로(2026-10-09 재현) 1초가 지난 뒤 요청한다.
    await page.waitForTimeout(1_200);
    await page.getByPlaceholder("이메일").fill(email);
    await page.getByRole("button", { name: "로그인 링크 받기" }).click();
    await expect(page.getByText(email)).toBeVisible();
    await page.goto(await nextConfirmationUrl(email, before));
    await expect(page).toHaveURL(/\/signup\/complete/);
  });

  test("매직링크를 요청과 다른 브라우저 컨텍스트에서 열어도 로그인된다(다른 기기 흉내)", async ({
    page,
    browser,
  }) => {
    const email = `e2e-crossdevice-${randomUUID()}@example.com`;

    await page.goto("/signup");
    const before = await mailCount(email);
    await page.getByPlaceholder("이메일").fill(email);
    // 필수 약관 2개에 동의해야 제출된다(가입 전 약관 동의). 안 체크하면 브라우저가 제출을 막는다.
    await page.getByRole("checkbox", { name: "이용약관에 동의합니다." }).check();
    await page.getByRole("checkbox", { name: "개인정보 수집 및 이용에 동의합니다." }).check();
    await page.getByRole("button", { name: "가입 링크 받기" }).click();
    await expect(page.getByText(email)).toBeVisible();

    const confirmationUrl = await nextConfirmationUrl(email, before);

    // 쿠키를 전혀 공유하지 않는 새 컨텍스트 — "다른 기기의 메일앱에서 링크를 눌렀다"와 같다.
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await otherPage.goto(confirmationUrl);
    // 가입 폼의 약관 동의로 링크를 누르면 바로 가입이 끝난다(예전엔 /signup/complete 약관 화면) — 쿠키 없는 다른 기기에서도 세션이 생겨 학생 화면이 열린다.
    await expect(otherPage).toHaveURL(/\/student\?welcome=1/);
    await otherContext.close();
  });
});
