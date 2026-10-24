import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import {
  createTestUser,
  retireTestUser,
  loginAs,
  admin,
  createCourseOffering,
  deleteCourseOffering,
  createApprovedOrder,
} from "./helpers";
import { runOutboxBatch } from "@/lib/wiring/outbox";

// 탈퇴 시나리오 F를 실제 브라우저 클릭으로 수행한다. 탈퇴는 되돌릴 수 없는
// 조작이므로 반드시 이 테스트가 만든 전용 계정으로만 진행하고, 끝나면 삭제한다
// (행 삭제는 테스트 정리 목적일 뿐, 프로덕션에서는 절대 하지 않는 것과 별개다).
test.describe("탈퇴", () => {
  let student: Awaited<ReturnType<typeof createTestUser>>;

  test.beforeEach(async ({ page }) => {
    student = await createTestUser({ role: "STUDENT", name: "홍길동", phone: "010-0000-0000" });
    await loginAs(page, student.email, student.password);
  });

  test.afterEach(async () => {
    await retireTestUser(student);
  });

  test("잘못된 이메일을 입력하면 탈퇴가 거부되고 계정은 그대로 남는다", async ({ page }) => {
    await page.goto("/student/profile");
    await page.getByPlaceholder("본인 이메일 입력").fill("wrong@example.com");
    await page.getByRole("button", { name: "탈퇴하기" }).click().catch(() => {});
    await page.waitForTimeout(1000);

    const { data: profile } = await admin
      .from("users")
      .select("withdrawn_at")
      .eq("id", student.id)
      .single();
    expect(profile?.withdrawn_at).toBeNull();
  });

  test("올바른 이메일을 입력하면 탈퇴 처리되고(행 삭제 없음) 이후 접근이 차단된다", async ({
    page,
  }) => {
    await page.goto("/student/profile");
    await page.getByPlaceholder("본인 이메일 입력").fill(student.email);
    await page.getByRole("button", { name: "탈퇴하기" }).click();

    await expect(page).toHaveURL("/withdrawn");

    // DB 행은 절대 삭제되지 않고 withdrawn_at만 기록돼야 한다("절대 삭제 금지").
    const { data: profile } = await admin
      .from("users")
      .select("id, withdrawn_at")
      .eq("id", student.id)
      .maybeSingle();
    expect(profile).not.toBeNull();
    expect(profile?.withdrawn_at).not.toBeNull();

    // 탈퇴 직후 같은 세션으로 다시 접근을 시도해도 서비스 화면에 못 들어간다.
    await page.goto("/student");
    await expect(page).toHaveURL(/\/withdrawn|\/login/);

    // 탈퇴는 회원 이벤트로도 남는다(withdraw_user 한 트랜잭션).
    const { count: withdrawnEvents } = await admin
      .from("account_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", student.id)
      .eq("event_type", "WITHDRAWN");
    expect(withdrawnEvents).toBe(1);
  });

  // "내가 부여했으니 내가 회수해야 한다" 원칙의 회귀 테스트.
  // withdraw()는 outbox_messages에 USER_WITHDRAWN(탈퇴 사실)만 적재하고, 실제 회수는 러너가 그 메시지를 이용권 모듈 핸들러에 배달할 때 일어난다 — 이 둘 사이를 잇는 payload.user_id를
  // 놓치면 에러 없이 entitlement가 영원히 살아남는, 조용히 실패하는
  // 지점이다. 실제 UI 결제 흐름은 payment.spec.ts가 이미 검증하므로, 여기서는
  // record_payment_event()를 직접 호출해 "이미 entitlement가 있는 상태"만 빠르게 만든다.
  test("탈퇴 시 이미 부여된 entitlement가 회수(revoked_at)된다", async ({ page }) => {
    const { courseId, offeringId } = await createCourseOffering({ price: 30000 });
    const enrollmentId = await createApprovedOrder(student.id, offeringId, 30000);

    try {
      const { error: payError } = await admin.rpc("record_payment_event", {
        p_provider: "INTERNAL",
        p_provider_event_id: randomUUID(),
        p_event_type: "PAYMENT_SUCCEEDED",
        p_amount: 30000,
        p_currency: "KRW",
        p_order_id: enrollmentId,
        p_payment_method: "OTHER",
        p_metadata: {},
        p_raw_payload: {},
      });
      expect(payError).toBeNull();
      await runOutboxBatch();

      const { data: entitlementsBefore } = await admin
        .from("entitlements")
        .select("id, revoked_at")
        .eq("user_id", student.id);
      expect(entitlementsBefore?.length ?? 0).toBeGreaterThan(0);
      expect(entitlementsBefore?.every((e) => e.revoked_at === null)).toBe(true);

      await page.goto("/student/profile");
      await page.locator('input[name="confirm_paid_orders_cancel"]').check();
      await page.getByPlaceholder("본인 이메일 입력").fill(student.email);
      await page.getByRole("button", { name: "탈퇴하기" }).click();
      await expect(page).toHaveURL("/withdrawn");

      // withdraw()가 적재한 USER_WITHDRAWN 메시지를 실제로 드레인해야 회수가 일어난다.
      await runOutboxBatch();

      const { data: entitlementsAfter } = await admin
        .from("entitlements")
        .select("id, revoked_at")
        .eq("user_id", student.id);
      expect(entitlementsAfter?.length).toBe(entitlementsBefore?.length);
      expect(entitlementsAfter?.every((e) => e.revoked_at !== null)).toBe(true);
    } finally {
      await deleteCourseOffering(offeringId, courseId);
    }
  });

  test("탈퇴 시 수강 중 주문도 취소된다(결제 상태는 그대로)", async ({ page }) => {
    const { courseId, offeringId } = await createCourseOffering({ price: 30000 });
    const enrollmentId = await createApprovedOrder(student.id, offeringId, 30000);

    try {
      const { error: payError } = await admin.rpc("record_payment_event", {
        p_provider: "INTERNAL",
        p_provider_event_id: randomUUID(),
        p_event_type: "PAYMENT_SUCCEEDED",
        p_amount: 30000,
        p_currency: "KRW",
        p_order_id: enrollmentId,
        p_payment_method: "OTHER",
        p_metadata: {},
        p_raw_payload: {},
      });
      expect(payError).toBeNull();
      await runOutboxBatch();

      await page.goto("/student/profile");
      await page.locator('input[name="confirm_paid_orders_cancel"]').check();
      await page.getByPlaceholder("본인 이메일 입력").fill(student.email);
      await page.getByRole("button", { name: "탈퇴하기" }).click();
      await expect(page).toHaveURL("/withdrawn");

      await runOutboxBatch();

      const { data: order } = await admin
        .from("orders")
        .select("status, payment_status, cancelled_at")
        .eq("id", enrollmentId)
        .single();
      expect(order?.status).toBe("CANCELLED");
      expect(order?.payment_status).toBe("PAID");
      expect(order?.cancelled_at).not.toBeNull();
    } finally {
      await deleteCourseOffering(offeringId, courseId);
    }
  });
});
