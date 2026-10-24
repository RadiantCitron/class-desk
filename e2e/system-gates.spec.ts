import { test, expect } from "@playwright/test";
import {
  createTestUser,
  retireTestUser,
  createCourseOffering,
  deleteCourseOffering,
  createApprovedOrder,
  loginAs,
  resetGates,
  gateSwitch,
  setSwitchViaUi,
  clearSwitchViaUi,
  admin,
  startPaymentInFakeToss,
} from "./helpers";

// 시스템 봉쇄 스위치(킬스위치, 2026-09-20). PAYMENT 게이트로 대표 시나리오를 검증한다 —
// SIGNUP·LOGIN은 상태 오염 위험이 크고 시나리오가 무거워 수동 검증으로 둔다.
//
// "ADMIN 본인은 봉쇄를 통과한다"는 PAYMENT에는 없다 — proxy.ts가 ADMIN을 /student/* 경로
// 자체에서 /admin으로 돌려보내므로(role 기반 라우팅, 게이트와 무관), ADMIN은 학생 결제 화면에
// 애초에 진입할 수 없다. 즉 PAYMENT 게이트의 ADMIN 예외는 구조적으로 시험할 수 없다(구현 중
// 발견, lib/guards/checkout/rules/payment-gate.ts 상단 주석과 동일한 이유로 그 규칙
// 자체도 ADMIN을 특별 취급하지 않는다). ADMIN 면제는 LOGIN 경로에서만 실질적 의미가 있고,
// 그건 수동 검증 대상이다.
test.describe("시스템 봉쇄 — PAYMENT", () => {
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let enrollmentId: string;
  const price = 50_000;

  test.beforeEach(async ({ page }) => {
    await resetGates();
    student = await createTestUser({ role: "STUDENT", name: "홍길동", phone: "010-0000-0000" });
    adminUser = await createTestUser({ role: "ADMIN" });
    ({ courseId, offeringId } = await createCourseOffering({ price }));
    enrollmentId = await createApprovedOrder(student.id, offeringId, price);
    await loginAs(page, student.email, student.password);
  });

  test.afterEach(async () => {
    await resetGates();
    await retireTestUser(student);
    await retireTestUser(adminUser);
    await deleteCourseOffering(offeringId, courseId);
  });

  test("ADMIN이 결제를 봉쇄하면 학생 결제 버튼이 사라지고 배너가 뜨며, 해제하면 다시 정상이다", async ({
    page,
  }) => {
    // 1) 봉쇄 전: 결제 버튼이 보인다.
    await page.goto(`/student/payment/${enrollmentId}`);
    await expect(page.getByRole("button", { name: "결제하기" })).toBeVisible();

    // 2) ADMIN이 /admin/system(스위치 화면)에서 결제 모듈을 전원에게 막는다(확인 창 + 사유 필수).
    await loginAs(page, adminUser.email, adminUser.password);
    await setSwitchViaUi(page, { level: "MODULE", target: "PAYMENT", reason: "e2e 테스트 — PG사 점검" });

    // 명령 레일 CR-2: 결제 봉쇄 상태는 통제 스위치 MODULE PAYMENT(전원) 행이다.
    const closedRow = await gateSwitch("PAYMENT");
    expect(closedRow.closed).toBe(true);
    expect(closedRow.reason).toBe("e2e 테스트 — PG사 점검");

    // 3) 학생 화면: 결제 버튼이 사라지고, 남은 조건 목록에 봉쇄 사유 메시지가 뜬다.
    await loginAs(page, student.email, student.password);
    await page.goto(`/student/payment/${enrollmentId}`);
    await expect(page.getByRole("button", { name: "결제하기" })).toHaveCount(0);
    // CR-4: 결제 봉쇄는 명령 레일(MODULE PAYMENT 스위치)의 사유로 보인다.
    await expect(page.getByText("결제 기능이 일시 중단되었습니다: e2e 테스트 — PG사 점검")).toBeVisible();

    // 4) 학생 대시보드에도 봉쇄 배너가 뜬다(components/GateBanner.tsx).
    await page.goto("/student");
    await expect(page.getByText(/결제 봉쇄됨/)).toBeVisible();

    // 5) ADMIN이 다시 연다 — 재개도 봉쇄와 같이 확인 모달 + 사유가 필수다
    // ("관리자가 바꾸는 상태 전이는 방향과 무관하게 전부 사유
    // 필수". 예전엔 해제는 확인 없이 즉시 처리됐다).
    await loginAs(page, adminUser.email, adminUser.password);
    await clearSwitchViaUi(page, "e2e 테스트 — PG사 점검", "e2e 테스트 — PG사 점검 종료");
    await expect(page.getByText("e2e 테스트 — PG사 점검 종료").first()).toBeVisible(); // 해제된 이력 표에 해제 사유가 남는다

    expect((await gateSwitch("PAYMENT")).closed).toBe(false);

    // 6) 학생 화면: 결제 버튼이 다시 보인다.
    await loginAs(page, student.email, student.password);
    await page.goto(`/student/payment/${enrollmentId}`);
    await expect(page.getByRole("button", { name: "결제하기" })).toBeVisible();

    // 7) 설정·해제 둘 다 감사로그에 남는다(누가 언제 왜 — actor_user_id로 ADMIN 확인). 명령은 공리 RAIL_SWITCH_SET이고
    // detail.op(SET/CLEAR)·detail.target으로 구분한다. 설정은 전원 대상이라 target_id가 비고, 해제는 해제한 스위치 id가 target_id다.
    const { data: logs } = await admin
      .from("audit_logs")
      .select("action, actor_user_id, target_id, detail")
      .eq("action", "RAIL_SWITCH_SET")
      .eq("phase", "SUCCEEDED")
      .order("created_at", { ascending: true });
    const paymentLogs = logs?.filter(
      (l) => (l.detail as { target?: string })?.target === "PAYMENT" && l.actor_user_id === adminUser.id,
    );
    expect(paymentLogs?.map((l) => (l.detail as { op: string }).op)).toEqual(["SET", "CLEAR"]);
    expect(paymentLogs?.[0].target_id).toBeNull();
    expect(paymentLogs?.[1].target_id).not.toBeNull();
  });

  test("확인 필수 모달 — 배경 클릭·ESC로는 닫히지 않고, 설정하면 결과 팝업이 뜨며 모달이 닫히고 목록에 올라온다", async ({
    page,
  }) => {
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto("/admin/system");
    await page.getByRole("button", { name: "스위치 설정" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();

    // 어두운 배경(모달 바깥, 화면 왼쪽 위 모서리)을 눌러도 닫히지 않는다.
    await page.mouse.click(2, 2);
    await expect(dialog).toBeVisible();
    // ESC를 연속으로 눌러도 닫히지 않는다(브라우저가 두 번째 ESC에 닫는 경우까지 보호).
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();

    // 시스템 전체 + 전원이면 영향이 가장 크다는 경고가 뜬다.
    await dialog.locator('select[name="level"]').selectOption("SYSTEM");
    await expect(dialog.getByText("스위치 화면을 제외한 모든 명령·조회가 관리자 포함 전원에게 멈춥니다")).toBeVisible();
    await dialog.locator('select[name="level"]').selectOption("MODULE");
    await dialog.locator('select[name="target"]').selectOption("PAYMENT");
    await dialog.locator('textarea[name="reason"]').fill("e2e 테스트 — 모달 확인");
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      dialog.getByRole("button", { name: "설정 확정" }).click(),
    ]);

    // 결과 팝업(성공)이 뜨고, 확인 버튼으로만 닫힌다. 설정 창은 사라진다.
    const result = page.getByRole("alertdialog");
    await expect(result).toHaveCount(1);
    await expect(result).toContainText("스위치를 설정했습니다");
    await page.mouse.click(2, 2);
    await page.keyboard.press("Escape");
    await expect(result).toBeVisible();
    await result.getByRole("button", { name: "확인" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);

    // 목록에 올라왔고, 같은 스위치를 또 켜려 하면 거부된다.
    // 스위치 화면은 해제된 스위치도 이력으로 보여 주므로, 앞선 실행이 남긴 같은 사유의 행과 겹치지 않게 이번 관리자의 행만 고른다.
    const row = page.locator("tbody tr", { hasText: "e2e 테스트 — 모달 확인" }).filter({ hasText: adminUser.email });
    await expect(row).toBeVisible();
    await expect(row).toContainText("전원");
    await page.getByRole("button", { name: "스위치 설정" }).click();
    const again = page.getByRole("alertdialog");
    await again.locator('select[name="level"]').selectOption("MODULE");
    await again.locator('select[name="target"]').selectOption("PAYMENT");
    await again.locator('textarea[name="reason"]').fill("e2e 테스트 — 중복");
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      again.getByRole("button", { name: "설정 확정" }).click(),
    ]);
    await expect(page.getByRole("alertdialog")).toContainText("같은 스위치가 이미 켜져 있습니다");
    await page.getByRole("alertdialog").getByRole("button", { name: "확인" }).click();

    // 해제는 사유가 필수인 인라인 폼이다 — 해제하면 목록에서 사라진다.
    await row.getByPlaceholder("해제 사유").fill("e2e 테스트 — 모달 확인 종료");
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      row.getByRole("button", { name: "해제" }).click(),
    ]);
    expect((await gateSwitch("PAYMENT")).closed).toBe(false);
  });

  test("결제 화면을 열어 둔 채 봉쇄되면, 이미 렌더된 버튼을 눌러도 서버가 거부한다(P-V2)", async ({
    page,
    browser,
  }) => {
    await page.goto(`/student/payment/${enrollmentId}`);
    await expect(page.getByRole("button", { name: "결제하기" })).toBeVisible();

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, adminUser.email, adminUser.password);
    await setSwitchViaUi(adminPage, { level: "MODULE", target: "PAYMENT", reason: "e2e 테스트 — PG사 점검" });
    await adminContext.close();

    await startPaymentInFakeToss(page);
    // CR-4: 결제창을 연 뒤 봉쇄되면 결제 시작 명령(PAYMENT_START)이 레일에서 거부된다.
    await expect(page.getByText(/결제 기능이 일시 중단되었습니다: e2e 테스트 — PG사 점검/)).toBeVisible();

    const { data: order } = await admin.from("orders").select("payment_status").eq("id", enrollmentId).single();
    expect(order?.payment_status).toBe("UNPAID");
  });
});
