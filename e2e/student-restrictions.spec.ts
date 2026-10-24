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
  resetUserSwitches,
  setSwitchViaUi,
  clearSwitchViaUi,
} from "./helpers";

// 개별 학생 3축 제한. 명령 레일 CR-7부터 제한은 통제 스위치(그 학생 대상)이고 관리자는
// 스위치 화면(/admin/system)에서 설정·해제한다 — system-gates.spec.ts와 같은 형태로 실제 화면을 클릭하고 학생 화면 반영을 확인한다. 3축은 서로 독립이므로
// 각 축을 별개 테스트로 나눈다(system-gates.spec.ts가 PAYMENT 하나만 대표로 검증하는 것과
// 달리, 여기는 3축이 각각 다른 화면/액션을 건드리므로 대표 시나리오로 압축할 수 없다).
test.describe("개별 학생 3축 제한(조회/수강신청/결제)", () => {
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let enrollmentId: string;
  const price = 50_000;

  test.beforeEach(async ({ page }) => {
    student = await createTestUser({ role: "STUDENT", name: "홍길동", phone: "010-0000-0000" });
    adminUser = await createTestUser({ role: "ADMIN" });
    ({ courseId, offeringId } = await createCourseOffering({ price, capacity: 3 }));
    enrollmentId = await createApprovedOrder(student.id, offeringId, price);
    await loginAs(page, student.email, student.password);
  });

  test.afterEach(async () => {
    // 명령 레일 CR-2: 학생 제한은 통제 스위치(그 유저 대상)다 — 삭제 금지라 해제로 정리한다.
    await resetUserSwitches(student.id);
    await retireTestUser(student);
    await retireTestUser(adminUser);
    await deleteCourseOffering(offeringId, courseId);
  });

  test("조회(VIEW)를 제한하면 대시보드가 안내로 바뀌고, 해제하면 정상 화면으로 돌아온다", async ({
    page,
  }) => {
    await page.goto("/student");
    await expect(page.getByText("개설 강의")).toBeVisible();

    await loginAs(page, adminUser.email, adminUser.password);
    await setSwitchViaUi(page, {
      level: "COMMAND",
      target: "STUDENT_HOME_VIEW",
      userEmail: student.email,
      reason: "e2e 테스트 — 조회 제한",
    });

    // 명령 레일 CR-7: 조회 제한 = 그 학생 대상 COMMAND STUDENT_HOME_VIEW 스위치(화면에서 조회 이름 하나씩 고른다).
    const { data: restriction } = await admin
      .from("rail_switches")
      .select("target, reason")
      .eq("user_id", student.id)
      .eq("level", "COMMAND")
      .is("cleared_at", null)
      .order("target");
    expect(restriction?.map((r) => r.target)).toEqual(["STUDENT_HOME_VIEW"]);
    expect(restriction?.every((r) => r.reason === "e2e 테스트 — 조회 제한")).toBe(true);

    await loginAs(page, student.email, student.password);
    await page.goto("/student");
    await expect(page.getByText("이용 제한")).toBeVisible();
    await expect(page.getByText("e2e 테스트 — 조회 제한")).toBeVisible();
    await expect(page.getByText("개설 강의")).toHaveCount(0);

    await loginAs(page, adminUser.email, adminUser.password);
    await clearSwitchViaUi(page, "e2e 테스트 — 조회 제한", "E2E 해제");

    await loginAs(page, student.email, student.password);
    await page.goto("/student");
    await expect(page.getByText("개설 강의")).toBeVisible();
  });

  test("수강신청(APPLY)을 제한하면 대시보드 버튼이 사유로 바뀌고 직접 URL 접근도 막히며, 해제하면 정상이다", async ({
    page,
  }) => {
    // 기존 offeringId는 이미 신청 완료 상태라 "신청 완료"만 뜬다 — "신청하기" 버튼이
    // 뜨는 새 개설강의를 하나 더 만든다.
    const { offeringId: newOfferingId, courseId: newCourseId, courseName: newCourseName } =
      await createCourseOffering({ price, capacity: 3 });

    await loginAs(page, adminUser.email, adminUser.password);
    await setSwitchViaUi(page, {
      level: "COMMAND",
      target: "ORDER_APPLY",
      userEmail: student.email,
      reason: "e2e 테스트 — 신청 제한",
    });

    await loginAs(page, student.email, student.password);
    await page.goto("/student");
    const offeringRow = page.locator("li", { hasText: newCourseName });
    // CR-4: 신청 버튼 사유는 명령 레일 판정 문구다(이 학생 대상 COMMAND ORDER_APPLY 스위치).
    await expect(offeringRow.getByText(/신청 불가: 관리자에 의해 수강 신청 기능이 제한되었습니다: e2e 테스트 — 신청 제한/)).toBeVisible();
    await expect(offeringRow.getByRole("link", { name: "신청하기" })).toHaveCount(0);

    // 직접 URL 접근 방어(서버 액션 자체 방어는 2중 방어 원칙 — 여기선 화면단만).
    await page.goto(`/student/apply/${newOfferingId}`);
    await expect(page).toHaveURL(/\/student$/);

    await loginAs(page, adminUser.email, adminUser.password);
    await clearSwitchViaUi(page, "e2e 테스트 — 신청 제한", "E2E 해제");

    await loginAs(page, student.email, student.password);
    await page.goto("/student");
    await expect(
      page.locator("li", { hasText: newCourseName }).getByRole("link", { name: "신청하기" }),
    ).toBeVisible();

    await deleteCourseOffering(newOfferingId, newCourseId);
  });

  test("결제(PAYMENT)를 제한하면 결제 페이지에 자격 미충족 메시지가 뜨고, 해제하면 결제 버튼이 다시 보인다", async ({
    page,
  }) => {
    await page.goto(`/student/payment/${enrollmentId}`);
    await expect(page.getByRole("button", { name: "결제하기" })).toBeVisible();

    await loginAs(page, adminUser.email, adminUser.password);
    await setSwitchViaUi(page, {
      level: "MODULE",
      target: "PAYMENT",
      userEmail: student.email,
      reason: "e2e 테스트 — 결제 분쟁",
    });

    await loginAs(page, student.email, student.password);
    await page.goto(`/student/payment/${enrollmentId}`);
    await expect(page.getByRole("button", { name: "결제하기" })).toHaveCount(0);
    // CR-4: 이 학생 대상 MODULE PAYMENT 스위치 — 명령 레일 문구.
    await expect(page.getByText("관리자에 의해 결제 기능이 제한되었습니다: e2e 테스트 — 결제 분쟁")).toBeVisible();

    await loginAs(page, adminUser.email, adminUser.password);
    await clearSwitchViaUi(page, "e2e 테스트 — 결제 분쟁", "E2E 해제");

    await loginAs(page, student.email, student.password);
    await page.goto(`/student/payment/${enrollmentId}`);
    await expect(page.getByRole("button", { name: "결제하기" })).toBeVisible();
  });

  test("직전 결제 시도(payment_attempts)가 남아 있어도 결제하기 버튼이 보인다(즉시 재시도)", async ({ page }) => {
    // 결제창을 닫아도 토스 신호가 안 오면 시도 행이 남는다 — 그래도 재시도를 막지 않는다.
    await admin.from("payment_attempts").insert({
      id: randomUUID(),
      order_id: enrollmentId,
      provider: "TOSS",
    });

    await page.goto(`/student/payment/${enrollmentId}`);
    await expect(page.getByRole("button", { name: "결제하기" })).toBeVisible();
    await expect(page.getByText("이미 진행 중인 결제 시도가 있습니다")).toHaveCount(0);
  });
});
