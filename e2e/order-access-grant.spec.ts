import { test, expect } from "@playwright/test";
import {
  createTestUser,
  retireTestUser,
  createCourseOffering,
  deleteCourseOffering,
  createApprovedOrder,
  closeTestOrder,
  loginAs,
  admin,
} from "./helpers";

// 직권 수강 부여: 관리자가 승인된 미결제 신청서에 사유를 남기고 결제 없이 수강권을 준다.
// [로컬] 전용(Playwright가 띄운 개발 서버 + 로컬 DB). 결제 원장에는 아무것도 쓰지 않는다.
test.describe("직권 수강 부여", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let orderId: string;
  const price = 50_000;

  test.beforeEach(async () => {
    adminUser = await createTestUser({ role: "ADMIN" });
    student = await createTestUser({ role: "STUDENT", name: "초대 수강생", phone: "010-0000-0000" });
    ({ courseId, offeringId } = await createCourseOffering({ price }));
    orderId = await createApprovedOrder(student.id, offeringId, price);
  });

  test.afterEach(async () => {
    // 주문·주문 이벤트·원장은 지우지 않는다(잔여는 db:reset). 테스트가 만든 이용권·경고만 치운다.
    await admin.from("entitlements").delete().eq("order_id", orderId);
    await admin.from("dead_letters").delete().contains("payload", { order_id: orderId });
    await admin.from("outbox_messages").delete().contains("payload", { order_id: orderId });
    // 미결제로 남은 주문은 닫아 둔다(방치 대사 경고 방지). 직권 부여된(WAIVED) 주문은 그대로 둔다 — closeTestOrder가 건드리지 않는다.
    await closeTestOrder(orderId, adminUser.id);
    await retireTestUser(adminUser);
    await retireTestUser(student);
    await deleteCourseOffering(offeringId, courseId);
  });

  test("관리자가 사유를 넣고 직권 부여 → 무료(직권 부여) 표시, 이용권 부여(결제 원장 없음), 감사 기록, 학생 화면에 무료(직권 부여)", async ({ page }) => {
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto(`/admin/orders/${orderId}`);

    // 승인됐지만 미결제인 신청서에는 수동 결제 확정과 직권 부여가 함께 보인다.
    await expect(page.getByRole("button", { name: "수동 확정" })).toBeVisible();
    await expect(page.getByText("직권 수강 부여 (결제 없이)")).toBeVisible();

    await page.getByPlaceholder(/부여 사유/).fill("초대 수강생 e2e");
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST" && res.ok()),
      page.getByRole("button", { name: "직권 부여" }).click(),
    ]);

    // 부여 뒤: 두 폼이 모두 사라지고 결제 상태가 무료(직권 부여)로 보인다.
    await expect(page.getByRole("button", { name: "직권 부여" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "수동 확정" })).toHaveCount(0);
    await expect(page.getByText("직권 부여(결제 없음)")).toBeVisible();
    await expect(page.getByText(/주문 이벤트: 직권 수강 부여/).first()).toBeVisible();
    await expect(page.getByText(/사유: 초대 수강생 e2e/).first()).toBeVisible();

    // DB: 결제 상태 WAIVED, 이용권은 ADMIN_GRANT 근거 한 벌(즉시 드레인 또는 다음 드레인), 결제 원장 0건.
    const { data: order } = await admin.from("orders").select("payment_status, status").eq("id", orderId).single();
    expect(order).toMatchObject({ payment_status: "WAIVED", status: "APPROVED" });

    await expect
      .poll(async () => {
        const { data } = await admin.from("entitlements").select("grant_source, payment_event_id").eq("order_id", orderId);
        return JSON.stringify(data);
      })
      .toBe(JSON.stringify([{ grant_source: "ADMIN_GRANT", payment_event_id: null }]));

    const { count: ledger } = await admin
      .from("payment_events")
      .select("id", { count: "exact", head: true })
      .eq("order_id", orderId);
    expect(ledger).toBe(0);

    // 감사 기록 — 시도와 성공이 사유와 함께 남는다.
    const { data: audits } = await admin
      .from("audit_logs")
      .select("phase, detail")
      .eq("action", "ORDER_ACCESS_GRANT")
      .eq("target_id", orderId);
    expect((audits ?? []).some((a) => a.phase === "SUCCEEDED" && (a.detail as { reason?: string }).reason === "초대 수강생 e2e")).toBe(true);

    // 학생 화면: 「무료(직권 부여)」로 보이고 결제하기 링크는 없다.
    await loginAs(page, student.email, student.password);
    await page.goto("/student");
    await expect(page.getByText("무료(직권 부여)").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "결제하기" })).toHaveCount(0);
  });

  test("사유 없이는 부여되지 않는다(브라우저 필수 입력) — 주문은 그대로 미결제", async ({ page }) => {
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto(`/admin/orders/${orderId}`);

    await page.getByRole("button", { name: "직권 부여" }).click();
    // required 입력이라 제출되지 않는다.
    const { data: order } = await admin.from("orders").select("payment_status").eq("id", orderId).single();
    expect(order?.payment_status).toBe("UNPAID");
    await expect(page.getByRole("button", { name: "직권 부여" })).toBeVisible();
  });
});
