import { test, expect, type Page } from "@playwright/test";
import {
  admin,
  createApprovedOrder,
  createCourseOffering,
  createTestUser,
  deleteCourseOffering,
  kstDateInput,
  loginAs,
  payWithTossSuccess,
  resetGates,
  retireTestUser,
  setActivePaymentProvider,
  tossPaymentKey,
  triggerTossWebhook,
  waitOrderPaymentStatus,
} from "./helpers";

// 수강생 환불 신청(신청만) · 관리자 처리(목록·거절·기존 환불 버튼) · 「수강 포기」 라벨. [로컬] 전용(가짜 토스).
// 환불은 PG 취소가 수락된 뒤 웹훅으로 확정되므로 확정은 웹훅 수동 트리거로 대신한다(admin-refund-ui와 같은 방식).
const resultDialog = (page: Page, ok: boolean) => page.getByRole("alertdialog", { name: ok ? "✔ 처리되었습니다" : "✖ 실패했습니다" });
const dialogWith = (page: Page, text: string) => page.getByRole("alertdialog").filter({ hasText: text });

test.describe("수강생 환불 신청", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let courseName: string;
  let offeringId: string;
  let orderId: string;
  const price = 30_000;
  const minute = 600 + Math.floor(Math.random() * 600); // 10:00~19:59 사이 한 시각(다른 실행의 회차와 겹치지 않게)
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  const rowOf = (page: Page) => page.locator("tbody tr", { hasText: courseName });

  async function setSessionDate(date: string) {
    // 모집 시작이 새 첫 회차보다 앞서야 하므로 먼저 과거로 당겨 둔다.
    await admin.from("course_offerings").update({ recruit_opens_at: new Date(Date.now() - 3 * 86_400_000).toISOString() }).eq("id", offeringId);
    require("child_process").execFileSync("docker", [
      "exec",
      "supabase_db_class-desk",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      `update public.course_sessions set session_date = '${date}' where course_offering_id = '${offeringId}';`,
    ]);
  }

  test.beforeEach(async ({ page }) => {
    await resetGates();
    adminUser = await createTestUser({ role: "ADMIN", name: "관리자" });
    await setActivePaymentProvider("TOSS", adminUser.id);
    student = await createTestUser({ role: "STUDENT", name: "환불학생", phone: "010-3333-4444" });
    ({ courseId, offeringId, courseName } = await createCourseOffering({ price, capacity: 5 }));
    // 개강 20일 전(약관 기준 100%) 하루짜리 회차
    const { error } = await admin.from("course_sessions").insert({
      course_offering_id: offeringId, session_date: kstDateInput(20), start_time: hhmm(minute), end_time: hhmm(minute + 30),
    });
    expect(error).toBeNull();
    orderId = await createApprovedOrder(student.id, offeringId, price);
    await loginAs(page, student.email, student.password);
    await payWithTossSuccess(page, orderId);
  });

  test.afterEach(async () => {
    // 주문은 지울 수 없어 남는다 — 열린 환불 신청이 다음 실행의 관리자 목록에 쌓이지 않도록 주문을 취소해 신청을 닫는다.
    if (orderId) await admin.from("orders").update({ status: "CANCELLED", cancelled_at: new Date().toISOString() }).eq("id", orderId);
    if (student) await retireTestUser(student);
    if (adminUser) await retireTestUser(adminUser);
    if (offeringId && courseId) {
      await admin.from("course_sessions").delete().eq("course_offering_id", offeringId);
      await deleteCourseOffering(offeringId, courseId).catch(() => undefined);
    }
  });

  async function studentRequests(page: Page, reason: string) {
    await page.goto("/student");
    await rowOf(page).getByRole("button", { name: "환불 신청", exact: true }).click();
    const dialog = dialogWith(page, "환불을 신청할까요?");
    await expect(dialog).toBeVisible();
    await dialog.locator('textarea[name="reason"]').fill(reason);
    await dialog.getByRole("button", { name: "환불 신청 확정" }).click();
    return dialog;
  }

  test("신청 → 관리자 목록·상세에 보임(주문은 그대로) → 관리자가 기존 환불 버튼으로 환불 → 「수강 포기(미수강)」 라벨", async ({ page }) => {
    // 학생: 버튼이 있고 약관 기준 예상 환불액(확정 아님)을 보여 준다
    await page.goto("/student");
    await rowOf(page).getByRole("button", { name: "환불 신청", exact: true }).click();
    const modal = dialogWith(page, "환불을 신청할까요?");
    await expect(modal.getByTestId("refund-proposal-text")).toContainText("30,000원");
    await expect(modal.getByTestId("refund-proposal-text")).toContainText("예상일 뿐");
    await modal.locator('textarea[name="reason"]').fill("e2e 개인 사정");
    await modal.getByRole("button", { name: "환불 신청 확정" }).click();
    await expect(resultDialog(page, true)).toBeVisible({ timeout: 30_000 });
    await expect(resultDialog(page, true)).toContainText("자동으로 환불되지 않습니다");
    await resultDialog(page, true).getByRole("button", { name: "확인" }).click();
    await expect(rowOf(page).getByTestId("refund-requested")).toContainText("환불 신청됨");
    await expect(rowOf(page).getByRole("button", { name: "환불 신청", exact: true })).toHaveCount(0); // 열린 신청이 있으면 다시 못 누른다

    // 신청만 했을 뿐 환불·종료되지 않았다. 신청 사건에는 사유와 신청 시점 제안이 남는다.
    const { data: order } = await admin.from("orders").select("status, payment_status, refunded_amount").eq("id", orderId).single();
    expect(order).toMatchObject({ status: "APPROVED", payment_status: "PAID", refunded_amount: 0 });
    const { data: ev } = await admin.from("order_events").select("payload, actor").eq("order_id", orderId).eq("event_type", "REFUND_REQUESTED").single();
    expect(ev?.actor).toBe("STUDENT");
    expect(ev?.payload).toMatchObject({ reason: "e2e 개인 사정", proposal: { amount: 30_000, stage: "BEFORE_START" } });

    // 관리자: 목록 맨 위 「환불 신청」 안내 + 행 배지, 상세에 사유와 두 제안
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto("/admin/orders");
    await expect(page.getByTestId("refund-requests")).toContainText("검토가 필요합니다");
    await expect(page.getByTestId(`refund-request-${orderId}`)).toContainText("환불 신청 (오늘)");
    await page.getByTestId(`refund-request-${orderId}`).getByRole("link").click();
    await expect(page.getByTestId("student-refund-request")).toContainText("e2e 개인 사정");
    await expect(page.getByTestId("student-refund-request")).toContainText("신청 시점 제안: 30,000원");
    await expect(page.getByTestId("student-refund-request")).toContainText("지금 기준:");
    await expect(page.getByTestId("refund-proposal")).toContainText("약관 기준 제안: 30,000원");

    // 관리자가 기존 「환불 요청」 버튼으로 전액 환불 → 웹훅 → 종료
    await page.getByRole("button", { name: "환불 요청", exact: true }).click();
    const refund = dialogWith(page, "환불을 요청할까요?");
    await refund.locator('textarea[name="reason"]').fill("e2e 학생 신청 처리");
    await refund.getByRole("button", { name: "환불 요청 확정" }).click();
    await expect(resultDialog(page, true)).toBeVisible({ timeout: 30_000 });
    await resultDialog(page, true).getByRole("button", { name: "확인" }).click();
    await triggerTossWebhook(await tossPaymentKey(orderId));
    await waitOrderPaymentStatus(orderId, "REFUNDED", 60_000);

    // 원인은 학생 신청에서 시작된 환불, 지난 회차 0 → 「수강 포기(미수강)」. 신청도 닫힘.
    const { data: cancelled } = await admin.from("order_events").select("payload").eq("order_id", orderId).eq("event_type", "CANCELLED").single();
    expect(cancelled?.payload).toMatchObject({ cause: "STUDENT_REFUND", past_sessions: 0, total_sessions: 1, partial: false });
    await page.goto(`/admin/orders/${orderId}`);
    await expect(page.getByTestId("end-label")).toHaveText("수강 포기(미수강)");
    await expect(page.getByTestId("student-refund-request")).toHaveCount(0);
    await page.goto("/admin/orders");
    await expect(page.getByTestId("refund-requests")).toHaveCount(0);
    await expect(page.locator("tbody tr", { hasText: courseName }).getByTestId("end-label")).toHaveText("수강 포기(미수강)");

    await loginAs(page, student.email, student.password);
    await page.goto("/student");
    await expect(rowOf(page)).toContainText("수강 포기(미수강)");
    await expect(rowOf(page).getByRole("button", { name: "환불 신청", exact: true })).toHaveCount(0);
  });

  test("관리자가 사유를 적어 거절 → 학생에게 사유가 보이고 다시 신청할 수 있다 / 거절해도 주문은 그대로", async ({ page }) => {
    await studentRequests(page, "e2e 첫 신청");
    await resultDialog(page, true).getByRole("button", { name: "확인" }).click();

    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto(`/admin/orders/${orderId}`);
    await page.getByRole("button", { name: "신청 거절", exact: true }).click();
    const reject = dialogWith(page, "환불 신청을 거절할까요?");
    await reject.locator('textarea[name="reason"]').fill("e2e 거절 사유 확인");
    await reject.getByRole("button", { name: "신청 거절 확정" }).click();
    await expect(resultDialog(page, true)).toBeVisible({ timeout: 30_000 });
    await resultDialog(page, true).getByRole("button", { name: "확인" }).click();
    await expect(page.getByTestId("student-refund-request")).toHaveCount(0);
    const { data: order } = await admin.from("orders").select("status, payment_status").eq("id", orderId).single();
    expect(order).toMatchObject({ status: "APPROVED", payment_status: "PAID" });

    await loginAs(page, student.email, student.password);
    await page.goto("/student");
    await expect(rowOf(page).getByTestId("refund-rejected")).toContainText("e2e 거절 사유 확인");
    await studentRequests(page, "e2e 다시 신청");
    await expect(resultDialog(page, true)).toBeVisible({ timeout: 30_000 });
    await resultDialog(page, true).getByRole("button", { name: "확인" }).click();
    await expect(rowOf(page).getByTestId("refund-requested")).toBeVisible();
    await expect(rowOf(page).getByTestId("refund-rejected")).toHaveCount(0);
  });

  test("약관 기준 불가 구간이어도 접수된다 — 경고 문구 확인 및 신청 사건 기록", async ({ page }) => {
    await setSessionDate(kstDateInput(0)); // 개강 당일 (약관 기준 0원 불가 구간)
    await page.goto("/student");
    await expect(rowOf(page).getByRole("button", { name: "환불 신청", exact: true })).toBeVisible();
    await rowOf(page).getByRole("button", { name: "환불 신청", exact: true }).click();
    const dialog = dialogWith(page, "환불을 신청할까요?");
    await expect(dialog.getByTestId("refund-proposal-text")).toContainText("약관상 환불 기준에 해당하지 않는 구간");
    await dialog.locator('textarea[name="reason"]').fill("e2e 불가 구간 신청");
    await dialog.getByRole("button", { name: "환불 신청 확정" }).click();
    await expect(resultDialog(page, true)).toBeVisible({ timeout: 30_000 });
    await resultDialog(page, true).getByRole("button", { name: "확인" }).click();
    await expect(rowOf(page).getByTestId("refund-requested")).toBeVisible();
    const { data: events } = await admin.from("order_events").select("payload").eq("order_id", orderId).eq("event_type", "REFUND_REQUESTED");
    expect(events ?? []).toHaveLength(1);
    expect(events![0].payload?.proposal?.eligible).toBe(false);
  });

  test("카드가 아닌 결제·무료(직권 부여)는 신청 버튼 자체가 없다 / 서버(DB)도 거부한다", async ({ page }) => {
    await admin.from("orders").update({ payment_method: "BANK_TRANSFER" }).eq("id", orderId);
    await page.goto("/student");
    await expect(rowOf(page).getByRole("button", { name: "환불 신청", exact: true })).toHaveCount(0);
    await expect(rowOf(page)).toContainText("환불은 관리자에게 문의해 주세요");
    const direct = await admin.rpc("request_order_refund", { p_order_id: orderId, p_user_id: student.id, p_reason: "우회", p_proposal: {} });
    expect(direct.error?.message).toContain("카드로 결제한 건만");

    // 무료(직권 부여): 결제 상태가 WAIVED인 신청
    const second = await createApprovedOrder(student.id, (await createSecondOffering()).offeringId, 0);
    const { error } = await admin.from("orders").update({ payment_status: "WAIVED" }).eq("id", second);
    expect(error).toBeNull();
    await page.goto("/student");
    await expect(page.getByText("무료(직권 부여)").first()).toBeVisible();
    const waived = await admin.rpc("request_order_refund", { p_order_id: second, p_user_id: student.id, p_reason: "무료", p_proposal: {} });
    expect(waived.error?.message).toContain("결제가 완료된 신청 건만");
  });

  async function createSecondOffering() {
    const created = await createCourseOffering({ price: 0, capacity: 5 });
    secondCourse = created;
    await admin.from("course_sessions").insert({
      course_offering_id: created.offeringId, session_date: kstDateInput(40), start_time: hhmm(minute), end_time: hhmm(minute + 30),
    });
    return created;
  }
  let secondCourse: { offeringId: string; courseId: string } | null = null;
  test.afterEach(async () => {
    if (secondCourse) {
      await admin.from("course_sessions").delete().eq("course_offering_id", secondCourse.offeringId);
      await deleteCourseOffering(secondCourse.offeringId, secondCourse.courseId).catch(() => undefined);
      secondCourse = null;
    }
  });

  test("오래 방치된 신청은 관리자 목록에서 경고색으로 경과일이 보인다(환불을 막지 않음)", async ({ page }) => {
    // 주문 이벤트는 append-only라 시각을 고칠 수 없다 — 6일 전에 들어온 신청 사건을 직접 만든다.
    const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();
    const { error } = await admin.from("order_events").insert({
      order_id: orderId, event_type: "REFUND_REQUESTED", actor: "STUDENT", actor_user_id: student.id, created_at: sixDaysAgo,
      payload: { reason: "e2e 방치", proposal: {}, requested_on: sixDaysAgo.slice(0, 10) },
    });
    expect(error).toBeNull();
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto("/admin/orders");
    const item = page.getByTestId(`refund-request-${orderId}`);
    await expect(item).toContainText("환불 신청 6일 경과");
    await expect(item.locator("span").last()).toHaveClass(/text-red-700/);
  });
});
