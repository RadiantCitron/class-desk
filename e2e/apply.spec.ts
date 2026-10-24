import { test, expect } from "@playwright/test";
import {
  createTestUser,
  retireTestUser,
  createCourseOffering,
  deleteCourseOffering,
  loginAs,
  admin,
} from "./helpers";

// 신청 시나리오 A/B를 실제 브라우저 클릭으로 수행한다.
test.describe("수강 신청 — 일반 강의(과목별 추가 약관 없음)", () => {
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let courseName: string;

  test.beforeEach(async ({ page }) => {
    student = await createTestUser({ role: "STUDENT", name: "홍길동", phone: "010-0000-0000" });
    ({ courseId, offeringId, courseName } = await createCourseOffering());
    await loginAs(page, student.email, student.password);
  });

  test.afterEach(async () => {
    await retireTestUser(student);
    await deleteCourseOffering(offeringId, courseId);
  });

  test("가입 시 이미 개인정보동의를 마쳤으므로 재동의 체크박스 없이 바로 신청된다", async ({
    page,
  }) => {
    await page.goto("/student");
    await page.locator("li", { hasText: courseName }).getByRole("link", { name: "신청하기" }).click();

    await expect(page).toHaveURL(new RegExp(`/student/apply/${offeringId}`));
    await expect(page.getByRole("heading", { name: new RegExp(courseName) })).toBeVisible();

    // PRIVACY_USE는 가입 시점에 이미 동의했다(e2e/helpers.ts의 createTestUser가 실제 가입
    // 흐름과 동일하게 SERVICE_USE+PRIVACY_USE를 함께 기록함) — "이미 최신판에 동의했으면
    // 재동의를 생략한다"(lib/terms.ts getRequiredTermsForOffering)는 설계를 실제 화면으로 확인.
    await expect(page.getByRole("checkbox")).toHaveCount(0);

    await page.getByRole("button", { name: "신청하기" }).click();

    await expect(page).toHaveURL("/student");
    await expect(page.locator("li", { hasText: courseName })).toContainText("신청 완료");

    const { data: enrollment } = await admin
      .from("orders")
      .select("status, payment_status")
      .eq("user_id", student.id)
      .eq("course_offering_id", offeringId)
      .single();
    expect(enrollment?.status).toBe("PENDING");
    expect(enrollment?.payment_status).toBe("UNPAID");
  });
});

test.describe("수강 신청 — 조건부 약관이 있는 강의(소스코드 결합 판매 등)", () => {
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let courseName: string;

  test.beforeEach(async ({ page }) => {
    student = await createTestUser({ role: "STUDENT", name: "홍길동", phone: "010-0000-0000" });
    ({ courseId, offeringId, courseName } = await createCourseOffering({
      requiredTermsTypes: ["SOFTWARE_LICENSE_USE"],
    }));
    await loginAs(page, student.email, student.password);
  });

  test.afterEach(async () => {
    await retireTestUser(student);
    await deleteCourseOffering(offeringId, courseId);
  });

  test("소프트웨어 이용허락동의 체크박스가 뜨고, 체크 안 하면 제출이 막힌다", async ({ page }) => {
    await page.goto(`/student/apply/${offeringId}`);

    // 이 강의는 PRIVACY_USE(이미 동의됨, 생략)와 달리 SOFTWARE_LICENSE_USE는 한 번도 동의한 적
    // 없으므로 체크박스가 정확히 1개(소프트웨어 이용허락동의) 떠야 한다 — 일반 강의(0개)와
    // 대비되는, "과목에 따라 필요한 약관이 다르다"는 요구의 핵심 확인 지점.
    await expect(page.getByRole("checkbox")).toHaveCount(1);
    // 약관 라벨 줄("… 이용허락 동의 (버전)")만 잡는다 — 약관 본문 첫 줄도 같은 제목이라 문구만으로 찾으면
    // 2곳에 걸려 strict 위반이 났다(로컬 DB 초기화 뒤 본문이 제목으로 시작, 2026-10-01 U 단계 4에서 발견).
    await expect(page.getByText(/^소프트웨어\(소스코드\) 이용허락 동의 \(/)).toBeVisible();

    await page.getByRole("button", { name: "신청하기" }).click();
    // required 체크박스 때문에 제출이 안 되고 같은 페이지에 머문다.
    await expect(page).toHaveURL(new RegExp(`/student/apply/${offeringId}`));

    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "신청하기" }).click();
    await expect(page).toHaveURL("/student");

    const { data: enrollment } = await admin
      .from("orders")
      .select("id")
      .eq("user_id", student.id)
      .eq("course_offering_id", offeringId)
      .single();

    const { data: agreements } = await admin
      .from("terms_agreements")
      .select("terms(type)")
      .eq("user_id", student.id);
    const agreedTypes = agreements?.map((a) => (a.terms as unknown as { type: string }).type);
    expect(agreedTypes).toContain("SOFTWARE_LICENSE_USE");
    expect(enrollment).not.toBeNull();
  });
});
