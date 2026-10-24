import { test, expect, type Page } from "@playwright/test";
import {
  admin,
  createApprovedOrder,
  createCourseOffering,
  createTestUser,
  deleteCourseOffering,
  fillSessionPicker,
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

// 일정 변경 안내·동의·미동의 처리. [로컬] 전용(가짜 토스).
// 관리자가 달력 모달로 일정을 바꾸면 살아 있는 신청마다 안내가 가고, 수강생이 동의/미동의로 한 번 응답하며,
// 동의하지 않았거나 응답 없는 수강생은 관리자가 직접 「제외 처리」한다(자동 제외 없음, 결제 건은 잔액 전부 환불).
const resultDialog = (page: Page, ok: boolean) => page.getByRole("alertdialog", { name: ok ? "✔ 처리되었습니다" : "✖ 실패했습니다" });
const dialogWith = (page: Page, text: string) => page.getByRole("alertdialog").filter({ hasText: text });

test.describe("일정 변경 안내·동의·미동의 처리", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  const students: Awaited<ReturnType<typeof createTestUser>>[] = [];
  let courseId: string;
  let courseName: string;
  let offeringId: string;
  const orderIds: string[] = [];
  const price = 30_000;
  const minute = 600 + Math.floor(Math.random() * 600);
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const d1 = kstDateInput(20);
  const d2 = kstDateInput(27);
  const d3 = kstDateInput(34);
  const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`; // 학생 화면의 날짜 표기(예: 11/5)

  const rowOf = (page: Page) => page.locator("tbody tr", { hasText: courseName });

  test.beforeEach(async () => {
    await resetGates();
    adminUser = await createTestUser({ role: "ADMIN", name: "관리자" });
    await setActivePaymentProvider("TOSS", adminUser.id);
    ({ courseId, offeringId, courseName } = await createCourseOffering({ price, capacity: 5 }));
    for (const date of [d1, d2]) {
      const { error } = await admin.from("course_sessions").insert({ course_offering_id: offeringId, session_date: date, start_time: hhmm(minute), end_time: hhmm(minute + 30) });
      expect(error).toBeNull();
    }
  });

  test.afterEach(async () => {
    for (const id of orderIds) await admin.from("orders").update({ status: "CANCELLED", cancelled_at: new Date().toISOString() }).eq("id", id);
    orderIds.length = 0;
    for (const s of students) await retireTestUser(s);
    students.length = 0;
    if (adminUser) await retireTestUser(adminUser);
    if (offeringId && courseId) {
      await admin.from("course_sessions").delete().eq("course_offering_id", offeringId);
      await deleteCourseOffering(offeringId, courseId).catch(() => undefined);
    }
  });

  async function newStudent(name: string) {
    const s = await createTestUser({ role: "STUDENT", name, phone: "010-5555-6666" });
    students.push(s);
    return s;
  }

  test("변경 → 학생 안내(배너 및 공지) → 환불 신청 접수 → 관리자 안내 현황 및 미결제자 제외 처리", async ({ page }) => {
    const paid = await newStudent("카드학생");
    const accepter = await newStudent("유지학생");
    const decliner = await newStudent("미결제학생");
    const paidOrder = await createApprovedOrder(paid.id, offeringId, price);
    const acceptOrder = await createApprovedOrder(accepter.id, offeringId, price);
    const declineOrder = await createApprovedOrder(decliner.id, offeringId, price);
    orderIds.push(paidOrder, acceptOrder, declineOrder);
    // 시험용 주문은 좌석을 직접 깎지 않고 만들어지므로(반환은 정원을 넘지 않게만 된다) 앱처럼 세 자리가 점유된 상태로 맞춘다.
    await admin.from("course_offerings").update({ remaining_seats: 2 }).eq("id", offeringId);
    await loginAs(page, paid.email, paid.password);
    await payWithTossSuccess(page, paidOrder);

    // 관리자: 달력 모달에서 둘째 날을 빼고 셋째 날을 더한다
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto(`/admin/course-offerings/${offeringId}`);
    await page.getByTestId("schedule-change").getByRole("button", { name: "일정 변경", exact: true }).click();
    const change = dialogWith(page, "일정을 변경할까요?");
    await expect(change).toContainText("신청(승인 대기·승인됨) 3명에게");
    await expect(change.getByTestId(`session-row-${d1}`)).toBeVisible(); // 현재 일정으로 미리 채워짐
    await change.getByRole("button", { name: `${d2} 빼기` }).click();
    await fillSessionPicker(page, { from: d3, until: d3, days: [], start: hhmm(minute), end: hhmm(minute + 30) });
    await change.locator('textarea[name="reason"]').fill("e2e 강사 사정");
    await change.getByRole("button", { name: "일정 변경 확정" }).click();
    await expect(resultDialog(page, true)).toBeVisible({ timeout: 30_000 });
    await resultDialog(page, true).getByRole("button", { name: "확인" }).click();

    const { data: sessions } = await admin.from("course_sessions").select("session_date").eq("course_offering_id", offeringId).is("deactivated_at", null).order("session_date");
    expect((sessions ?? []).map((s) => s.session_date)).toEqual([d1, d3]);
    const { data: notices } = await admin.from("order_events").select("order_id").eq("event_type", "SCHEDULE_CHANGE_NOTICE").in("order_id", orderIds);
    expect((notices ?? []).map((n) => n.order_id).sort()).toEqual([...orderIds].sort());

    // 관리자: 안내 현황 테이블 확인 (안내됨 상태)
    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(page.getByTestId("schedule-responses")).toContainText("일정 변경 안내 현황");
    await expect(page.getByTestId(`schedule-response-${acceptOrder}`)).toContainText("안내됨");

    // 학생: 안내 카드 확인 (배너 및 전/후 일정 노출)
    await loginAs(page, accepter.email, accepter.password);
    await page.goto("/student");
    await expect(rowOf(page).getByTestId("schedule-before")).toContainText(md(d2));
    await expect(rowOf(page).getByTestId("schedule-after")).toContainText(md(d3));

    // 카드 결제 학생: 「이 변경으로 환불 신청」 클릭하여 접수
    await loginAs(page, paid.email, paid.password);
    await page.goto("/student");
    await rowOf(page).getByRole("button", { name: "이 변경으로 환불 신청", exact: true }).click();
    const refundDialog = dialogWith(page, "일정 변경으로 인한 환불 신청");
    await refundDialog.locator('textarea[name="reason"]').fill("일정 변경으로 수강 불가");
    await refundDialog.getByRole("button", { name: "환불 신청 확정" }).click();
    await expect(resultDialog(page, true)).toBeVisible({ timeout: 30_000 });
    await resultDialog(page, true).getByRole("button", { name: "확인" }).click();
    await expect(rowOf(page).getByTestId("schedule-change-refund-requested")).toContainText("일정 변경으로 환불을 신청했습니다");

    // 관리자: 안내 현황에서 환불 신청 상태 확인 및 미결제자 제외 처리
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(page.getByTestId(`schedule-response-${paidOrder}`)).toContainText("환불 신청됨");

    // 미결제자: 제외 처리 실행 (환불 없이 바로 제외, 좌석 반환)
    const { data: seatsBefore } = await admin.from("course_offerings").select("remaining_seats").eq("id", offeringId).single();
    await page.getByTestId(`schedule-response-${declineOrder}`).getByRole("button", { name: "제외 처리" }).click();
    const excludeDialog = dialogWith(page, "이 수강생을 수업에서 제외할까요?");
    await excludeDialog.locator('textarea[name="memo"]').fill("e2e 일정 변경으로 인한 제외");
    await excludeDialog.getByRole("button", { name: "제외 처리 확정" }).click();
    await expect(resultDialog(page, true)).toBeVisible({ timeout: 30_000 });
    await resultDialog(page, true).getByRole("button", { name: "확인" }).click();
    const { data: declined } = await admin.from("orders").select("status").eq("id", declineOrder).single();
    expect(declined?.status).toBe("CANCELLED");
    const { data: seatsAfter } = await admin.from("course_offerings").select("remaining_seats").eq("id", offeringId).single();
    expect(seatsAfter!.remaining_seats).toBe(seatsBefore!.remaining_seats + 1);
    const { data: closedEvent } = await admin.from("order_events").select("payload").eq("order_id", declineOrder).eq("event_type", "CANCELLED").single();
    expect(closedEvent?.payload).toMatchObject({ cause: "SCHEDULE_CHANGE" });
  });

  test("개강 후에는 일정 변경이 잠기고, 결제 완료 건은 관리자 상세에서 선별 환불로 안내된다", async ({ page }) => {
    const bank = await newStudent("무통장학생");
    const bankOrder = await createApprovedOrder(bank.id, offeringId, price);
    orderIds.push(bankOrder);
    const now = new Date().toISOString();
    await admin.from("orders").update({ payment_status: "PAID", paid_at: now, payment_method: "BANK_TRANSFER" }).eq("id", bankOrder);

    const { data: sessions } = await admin.from("course_sessions").select("id, session_date, start_time, end_time").eq("course_offering_id", offeringId).is("deactivated_at", null).order("session_date");
    const { error: applyError } = await admin.rpc("apply_schedule_change", {
      p_offering_id: offeringId,
      p_actor: adminUser.id,
      p_actor_role: "ADMIN",
      p_reason: "e2e 직접 호출",
      p_cancel_session_ids: [sessions![1].id],
      p_add_sessions: [{ date: d3, start: hhmm(minute), end: hhmm(minute + 30) }],
    });
    expect(applyError).toBeNull();

    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(page.getByTestId(`schedule-response-${bankOrder}`)).toContainText("결제 수강생 (선별 환불 또는 주문 상세에서 처리)");
    await expect(page.getByTestId(`schedule-response-${bankOrder}`).getByRole("button", { name: "제외 처리" })).toHaveCount(0);

    // 서버도 거부한다(DB 함수는 결제 완료 건의 직접 제외를 받지 않는다)
    const direct = await admin.rpc("exclude_order_for_schedule_change", { p_order_id: bankOrder, p_actor_id: adminUser.id, p_actor_role: "ADMIN", p_reason: "우회" });
    expect(direct.error).not.toBeNull();

    // F-4: 개강 후에도 시작 전 활성 회차가 남아 있으면 변경 가능하나,
    // 모든 회차가 시작되었거나 종료되었으면 변경 자체가 잠긴다.
    // (회차 날짜 수정은 불변 트리거가 막으므로 테스트 정리 목적으로 psql로 과거 날짜 설정)
    require("child_process").execFileSync("docker", [
      "exec",
      "supabase_db_class-desk",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      `update public.course_offerings set recruit_opens_at = (current_date - interval '30 days') where id = '${offeringId}';
       with ordered as (
         select id, row_number() over () as rn from public.course_sessions where course_offering_id = '${offeringId}'
       )
       update public.course_sessions s
       set session_date = (current_date - (ordered.rn + 10) * interval '1 day')::date,
           start_time = '00:00:00', end_time = '00:30:00'
       from ordered
       where s.id = ordered.id;`,
    ]);
    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(page.getByTestId("schedule-change").getByRole("button", { name: "일정 변경", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("schedule-change-lock")).toContainText("시작 전인 남은 회차가 없어");
  });
});
