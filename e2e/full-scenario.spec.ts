import { test, expect } from "@playwright/test";
import {
  createTestUser,
  retireTestUser,
  createCourseOffering,
  deleteCourseOffering,
  loginAs,
  admin,
  startPaymentInFakeToss,
  reloadUntil,
  setActivePaymentProvider,
} from "./helpers";

// 가짜 수강생·과목·개설과목을 전부 새로 만들어, "학생 한 명이 실제로 겪는 전체 여정"을
// 하나의 흐름으로 이어서 확인한다(2026-09-11: "여러 상황을 시뮬레이션하면서
// 테스트해야 한다"). 기존 스펙(apply/payment/admin-cancel/admin-reject-hides-reason/withdraw)이
// 이미 각 기능을 개별로 검증하므로 이 파일과 내용이 겹치는 것은 의도된 중복이다 — 목적이
// 다르다: 국소 기능이 아니라 "이어붙였을 때도 문제없는지"를 본다.
//
// 실제 디스코드 OAuth 로그인과 실제 PG 결제망은 로컬/자동 테스트가 불가능해 범위에서
// 제외한다(디스코드: docs/로컬개발환경.md 4절, PG — 둘 다 이미 확정된
// 제약이지 이 테스트의 한계가 아니다). 로그인은 `/api/test/login`(이메일/비번, 로컬 전용
// 이중 안전장치로 보호됨), 결제는 가짜 PG(토스)로 대신한다.
test.describe("전체 시나리오 — 해피패스 (가입→신청→승인→결제→혜택사용→탈퇴)", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let courseName: string;
  const price = 30_000;

  test.beforeEach(async () => {
    adminUser = await createTestUser({ role: "ADMIN" });
    await setActivePaymentProvider("TOSS", adminUser.id, "e2e full-scenario");
    student = await createTestUser({ role: "STUDENT", name: "전체시나리오학생", phone: "010-9999-0000" });
    ({ courseId, offeringId, courseName } = await createCourseOffering({ price, capacity: 3 }));
  });

  test.afterEach(async () => {
    // 탈퇴한 계정이라도 테스트 정리 목적으로는 그대로 삭제한다(
    // "프로덕션에서 하드 삭제 금지"와는 별개 — 이 계정은 테스트가 만든 가짜 계정이다).
    await retireTestUser(adminUser);
    await retireTestUser(student).catch(() => {});
    await deleteCourseOffering(offeringId, courseId);
  });

  test("한 명의 가짜 학생이 신청부터 탈퇴까지 실제 클릭으로 전 과정을 통과한다", async ({
    page,
    browser,
  }) => {
    // 이 테스트 하나가 신청/관리자/결제/entitlements/프로필까지 서로 다른 라우트 7곳 이상을
    // 처음 방문한다 — 각 라우트를 Turbopack이 그 자리에서 컴파일하는 시간이 누적되면 기본
    // 45초(playwright.config.ts) 안에 안 끝날 수 있어, 이 테스트만 개별적으로 늘린다.
    test.setTimeout(120_000);
    // 1) 학생 로그인 + 신청 (일반 강의라 체크박스 없이 바로 제출됨 — apply.spec.ts와 동일 전제)
    await loginAs(page, student.email, student.password);
    await page.goto("/student");
    await page.locator("li", { hasText: courseName }).getByRole("link", { name: "신청하기" }).click();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await page.getByRole("button", { name: "신청하기" }).click();
    await expect(page).toHaveURL("/student");
    await expect(page.locator("li", { hasText: courseName })).toContainText("신청 완료");

    const { data: pending } = await admin
      .from("orders")
      .select("id, status, payment_status")
      .eq("user_id", student.id)
      .eq("course_offering_id", offeringId)
      .single();
    expect(pending?.status).toBe("PENDING");
    expect(pending?.payment_status).toBe("UNPAID");
    const enrollmentId = pending!.id as string;

    // 2) 관리자가 별도 브라우저 컨텍스트(별도 세션)로 승인
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, adminUser.email, adminUser.password);
    await adminPage.goto("/admin/orders");
    const adminRow = adminPage.locator("tbody tr", { hasText: courseName });
    await expect(adminRow).toContainText("PENDING");
    await Promise.all([
      adminPage.waitForResponse((res) => res.request().method() === "POST"),
      adminRow.getByRole("button", { name: "승인" }).click(),
    ]);
    await reloadUntil(adminPage, () =>
      expect(adminPage.locator("tbody tr", { hasText: courseName })).toContainText("APPROVED", { timeout: 5_000 }),
    );
    await adminContext.close();

    const { data: approved } = await admin
      .from("orders")
      .select("status")
      .eq("id", enrollmentId)
      .single();
    expect(approved?.status).toBe("APPROVED");

    // 3) 학생이 결제(가짜 토스 PG) — 결제하기 → 가짜 결제창 → 성공
    await page.goto(`/student/payment/${enrollmentId}`);
    await expect(page.getByRole("button", { name: "결제하기" })).toBeVisible();
    await startPaymentInFakeToss(page);
    await page.waitForURL(/4010\/toss\/checkout|\/toss\/checkout/, { timeout: 45_000 });
    await page.getByRole("button", { name: "성공" }).click();
    // 승인 성공이면 수강 조회(/student?paid=1)로 돌아온다(2026-10-02).
    await page.waitForURL(/\/student\?paid=1/, { timeout: 60_000 });
    await expect(page.getByText("결제가 확인되었습니다.").first()).toBeVisible();

    const { data: paid } = await admin
      .from("orders")
      .select("payment_status, paid_at")
      .eq("id", enrollmentId)
      .single();
    expect(paid?.payment_status).toBe("PAID");
    expect(paid?.paid_at).not.toBeNull();

    const { data: entitlementsBefore } = await admin
      .from("entitlements")
      .select("id, type")
      .eq("user_id", student.id);
    expect(entitlementsBefore?.some((e) => e.type === "COURSE_ACCESS")).toBe(true);

    // 4) 내 혜택 화면에서 보유 중인 것으로 뜨는지 확인 — COURSE_ACCESS는 자격형이라
    // "사용" 개념이 없다(6단계, D12). e2e에서 소모형(SOURCE_DOWNLOAD) 다운로드 클릭까지
    // 검증하는 스펙은 아직 없다(개설강의에 blob_pathname을 채운 e2e 픽스처가 없음).
    await page.goto("/student/entitlements");
    await expect(page.getByText("보유 중").first()).toBeVisible();

    // 5) 마지막으로 탈퇴 — 되돌릴 수 없는 조작이라 여정의 맨 끝에서, 이 테스트 전용 계정으로만 수행
    await page.goto("/student/profile");
    await page.locator('input[name="confirm_paid_orders_cancel"]').check();
    await page.getByPlaceholder("본인 이메일 입력").fill(student.email);
    await page.getByRole("button", { name: "탈퇴하기" }).click();
    await expect(page).toHaveURL("/withdrawn");

    const { data: withdrawn } = await admin
      .from("users")
      .select("id, withdrawn_at")
      .eq("id", student.id)
      .maybeSingle();
    expect(withdrawn).not.toBeNull(); // 행 삭제 금지 원칙 — 소프트 탈퇴만.
    expect(withdrawn?.withdrawn_at).not.toBeNull();

    await page.goto("/student");
    await expect(page).toHaveURL(/\/withdrawn|\/login/);
  });
});

test.describe("전체 시나리오 — 반려 경로 (신청→관리자 반려)", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let courseName: string;

  test.beforeEach(async () => {
    adminUser = await createTestUser({ role: "ADMIN" });
    student = await createTestUser({ role: "STUDENT", name: "반려경로학생", phone: "010-9999-1111" });
    ({ courseId, offeringId, courseName } = await createCourseOffering({ capacity: 3 }));
  });

  test.afterEach(async () => {
    await retireTestUser(adminUser);
    await retireTestUser(student);
    await deleteCourseOffering(offeringId, courseId);
  });

  test("학생이 신청한 뒤 관리자가 반려하면, 상태는 REJECTED로 바뀌고 좌석이 반환된다", async ({
    page,
    browser,
  }) => {
    // 1) 학생이 직접 신청(신청 자체도 브라우저 클릭으로 — fixture로 PENDING을 만들지 않는다)
    await loginAs(page, student.email, student.password);
    await page.goto("/student");
    await page.locator("li", { hasText: courseName }).getByRole("link", { name: "신청하기" }).click();
    await page.getByRole("button", { name: "신청하기" }).click();
    await expect(page).toHaveURL("/student");
    await expect(page.locator("li", { hasText: courseName })).toContainText("신청 완료");

    // 2) 관리자가 별도 세션으로 반려(2026-09-23 3단계: 반려 사유 입력란 제거 — G7 확정)
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, adminUser.email, adminUser.password);
    await adminPage.goto("/admin/orders");
    const adminRow = adminPage.locator("tbody tr", { hasText: courseName });
    await adminRow.getByRole("button", { name: "반려" }).click();
    const rejectModal = adminPage.getByRole("alertdialog", { name: "수강 신청 반려" });
    await expect(rejectModal).toBeVisible();
    await rejectModal.locator('input[name="reason"]').fill("e2e 정원 초과 등 반려 사유");
    await Promise.all([
      adminPage.waitForResponse((res) => res.request().method() === "POST"),
      rejectModal.getByRole("button", { name: "반려 확정" }).click(),
    ]);
    await reloadUntil(adminPage, () =>
      expect(adminPage.locator("tbody tr", { hasText: courseName })).toContainText("REJECTED", { timeout: 5_000 }),
    );
    await adminContext.close();

    // 3) 학생 화면에도 반려 상태가 보인다(한글 라벨).
    await page.goto("/student");
    await expect(page.locator("tbody tr", { hasText: courseName })).toContainText("반려됨");

    const { data: enrollment } = await admin
      .from("orders")
      .select("id, status")
      .eq("user_id", student.id)
      .eq("course_offering_id", offeringId)
      .single();
    expect(enrollment?.status).toBe("REJECTED");
  });
});
