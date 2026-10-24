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
  countIntegrityDlq,
  triggerAdminOutboxDrain,
} from "./helpers";

const UNRESOLVED_CONFIRM_CHECK = "UNRESOLVED_CONFIRM";

test.describe("승인 결과 미기록 → 수동 확정 (대사⑦)", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let orderId: string;
  const price = 50_000;

  test.beforeEach(async () => {
    adminUser = await createTestUser({ role: "ADMIN" });
    student = await createTestUser({ role: "STUDENT", name: "홍길동", phone: "010-0000-0000" });
    ({ courseId, offeringId } = await createCourseOffering({ price }));
    orderId = await createApprovedOrder(student.id, offeringId, price);

    // 승인을 요청한 지 30분이 넘었는데 결과가 없는 시도를 직접 만든다(UNRESOLVED_CONFIRM_MINUTES=30, D2).
    const past = new Date(Date.now() - 40 * 60_000).toISOString();
    await admin.from("payment_attempts").insert({
      id: randomUUID(),
      order_id: orderId,
      provider: "TOSS",
      created_at: past,
      confirm_requested_at: past,
    });
  });

  test.afterEach(async () => {
    // 결제 원장·결제 요청·주문은 지우지 않는다(원장·결제 요청은 DB 트리거가 막고, 주문은 원장 FK로 막힌다 —
    // 예전엔 여기서 delete를 불러 조용히 실패하거나 결제 요청만 실제로 지워졌다). 잔여는 db:reset으로 정리.
    await admin.from("dead_letters").delete().contains("payload", { order_id: orderId });
    await admin.from("entitlements").delete().eq("order_id", orderId);
    await retireTestUser(adminUser);
    await retireTestUser(student);
    await deleteCourseOffering(offeringId, courseId);
  });

  test("승인 요청 후 30분 지나도 결과 없음 → 대사⑦ 경고 → 관리자 수동 확정 → 이용권 부여", async ({
    page,
  }) => {
    await loginAs(page, adminUser.email, adminUser.password);

    await triggerAdminOutboxDrain(page);
    await expect(page.getByRole("button", { name: "아웃박스 지금 처리" })).toBeEnabled();

    // 대사⑦ DLQ는 배치 직후에도 PostgREST 반영이 한 박자 늦을 수 있다 — 폴링한다.
    // 한 번 더 드레인해도 멱등(이미 있으면 중복 적재 안 함, admin-integrity.spec.ts와 동일).
    await expect
      .poll(async () => {
        const count = await countIntegrityDlq(orderId, UNRESOLVED_CONFIRM_CHECK);
        if (count > 0) return count;
        await triggerAdminOutboxDrain(page);
        await expect(page.getByRole("button", { name: "아웃박스 지금 처리" })).toBeEnabled();
        return await countIntegrityDlq(orderId, UNRESOLVED_CONFIRM_CHECK);
      })
      .toBeGreaterThan(0);

    await page.goto(`/admin/orders/${orderId}`);
    await page.getByPlaceholder(/확정 사유/).fill("계좌이체 확인, 테스트");
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST" && res.ok()),
      page.getByRole("button", { name: "수동 확정" }).click(),
    ]);
    await expect(page.getByRole("button", { name: "수동 확정" })).toHaveCount(0);

    await expect
      .poll(async () => {
        const { data } = await admin.from("orders").select("payment_status").eq("id", orderId).single();
        return data?.payment_status;
      })
      .toBe("PAID");

    await page.reload();
    // NOT_ALREADY_PAID·ORDER_PAID 등 다른 "PAID" 부분 문자열과 구분 — 결제상태 dd만 본다.
    await expect(page.locator("dt", { hasText: "결제상태" }).locator("+ dd")).toHaveText("PAID");

    await expect
      .poll(async () => {
        const { count } = await admin
          .from("entitlements")
          .select("id", { count: "exact", head: true })
          .eq("order_id", orderId);
        return count ?? 0;
      })
      .toBeGreaterThan(0);
  });
});
