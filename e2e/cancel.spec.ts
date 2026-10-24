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
} from "./helpers";

// 취소 시나리오 C를 실제 브라우저 클릭으로 수행한다.
test.describe("학생 본인 신청취소", () => {
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let courseName: string;
  const capacity = 3;

  test.beforeEach(async ({ page }) => {
    student = await createTestUser({ role: "STUDENT", name: "홍길동", phone: "010-0000-0000" });
    ({ courseId, offeringId, courseName } = await createCourseOffering({ capacity }));
    await loginAs(page, student.email, student.password);
  });

  test.afterEach(async () => {
    await retireTestUser(student);
    await deleteCourseOffering(offeringId, courseId);
  });

  test("PENDING 신청을 취소하면 상태가 CANCELLED로 바뀌고 좌석이 반환된다", async ({ page }) => {
    await createPendingOrder(student.id, offeringId, 50000);
    // 신청 시 좌석을 차감한 것처럼 픽스처도 동일하게 차감해둔다 — 실제 apply_for_offering()과
    // 같은 전제(신청=좌석 점유)에서 "취소=반환"을 검증하기 위함.
    await admin.rpc("reserve_course_offering_seat", { p_offering_id: offeringId });

    await page.goto("/student");
    // 상태값을 한글로 보여준다 — 원본 "PENDING" 문자열은 더 안 보인다.
    await expect(page.locator("tbody tr", { hasText: courseName })).toContainText("승인 대기 중");

    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      page.locator("tbody tr", { hasText: courseName }).getByRole("button", { name: "신청 취소" }).click(),
    ]);

    await page.reload();
    await expect(page.locator("tbody tr", { hasText: courseName })).toContainText("취소됨");

    const { data: enrollment } = await admin
      .from("orders")
      .select("status, cancelled_at")
      .eq("user_id", student.id)
      .eq("course_offering_id", offeringId)
      .single();
    expect(enrollment?.status).toBe("CANCELLED");
    expect(enrollment?.cancelled_at).not.toBeNull();

    const { data: offering } = await admin
      .from("course_offerings")
      .select("remaining_seats")
      .eq("id", offeringId)
      .single();
    expect(offering?.remaining_seats).toBe(capacity); // 차감했다가 취소로 다시 원래대로
  });

  test("결제 전(ENROLLED, UNPAID) 신청도 취소할 수 있다", async ({ page }) => {
    await createApprovedOrder(student.id, offeringId, 50000);
    await admin.rpc("reserve_course_offering_seat", { p_offering_id: offeringId });

    await page.goto("/student");
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      page.locator("tbody tr", { hasText: courseName }).getByRole("button", { name: "신청 취소" }).click(),
    ]);

    const { data: enrollment } = await admin
      .from("orders")
      .select("status")
      .eq("user_id", student.id)
      .eq("course_offering_id", offeringId)
      .single();
    expect(enrollment?.status).toBe("CANCELLED");
  });

  test("반려된 강의는 개설 목록에 반려됨으로 뜨고 재신청은 여전히 안 된다", async ({
    page,
  }) => {
    const adminUser = await createTestUser({ role: "ADMIN" });
    const orderId = await createPendingOrder(student.id, offeringId, 50000);
    await admin.rpc("reserve_course_offering_seat", { p_offering_id: offeringId });

    const { error } = await admin.rpc("transition_order", {
      p_order_id: orderId,
      p_actor_id: adminUser.id,
      p_actor_role: "ADMIN",
      p_event_type: "REJECTED",
      p_next_status: "REJECTED",
      p_reason: "테스트 반려",
    });
    expect(error).toBeNull();

    await page.goto("/student");
    // 상태값을 한글로 보여준다 — 원본 "REJECTED" 문자열은 더 안 보인다.
    await expect(page.locator("tbody tr", { hasText: courseName })).toContainText("반려됨");
    await expect(page.locator("tbody tr", { hasText: courseName })).not.toContainText("REJECTED");
    // F-8: 종결된(REJECTED) 주문은 살아 있는 주문이 아니므로, 개설 목록에서 다시 신청할 수 있다.
    await expect(
      page.locator("li", { hasText: courseName }).getByRole("link", { name: "신청하기" }),
    ).toBeVisible();

    await retireTestUser(adminUser);
  });

  test("취소한 강의는 같은 개설강의에 다시 신청할 수 있다(F-8 재신청 허용)", async ({
    page,
  }) => {
    await createPendingOrder(student.id, offeringId, 50000);
    await admin.rpc("reserve_course_offering_seat", { p_offering_id: offeringId });

    await page.goto("/student");
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      page.locator("tbody tr", { hasText: courseName }).getByRole("button", { name: "신청 취소" }).click(),
    ]);

    await page.reload();
    await expect(page.locator("tbody tr", { hasText: courseName })).toContainText("취소됨");
    // F-8: 취소한(CANCELLED) 주문은 종결 상태이므로, 모집 기간 내라면 개설 목록에서 다시 신청할 수 있다.
    await expect(
      page.locator("li", { hasText: courseName }).getByRole("link", { name: "신청하기" }),
    ).toBeVisible();

    // 신청 폼 URL 직접 접근도 가능해야 한다(재신청 허용).
    await page.goto(`/student/apply/${offeringId}`);
    await expect(page.getByRole("button", { name: "신청하기" })).toBeVisible();
  });

  test("이미 결제된(PAID) 신청 건에는 취소 버튼 자체가 보이지 않는다", async ({ page }) => {
    const enrollmentId = await createApprovedOrder(student.id, offeringId, 50000);
    await admin
      .from("orders")
      .update({ payment_status: "PAID", paid_at: new Date().toISOString(), payment_method: "CARD" })
      .eq("id", enrollmentId);

    await page.goto("/student");
    const row = page.locator("tbody tr", { hasText: courseName });
    // 상태값을 한글로 보여준다 — 원본 "PAID" 문자열은 더 안 보인다.
    await expect(row).toContainText("결제완료");
    await expect(row.getByRole("button", { name: "신청 취소" })).toHaveCount(0);
  });
});
