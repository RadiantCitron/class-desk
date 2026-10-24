import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "crypto";
import {
  admin,
  createCourseOffering,
  createPendingOrder,
  createTestUser,
  deleteCourseOffering,
  kstDateInput,
  kstLocalInput,
  loginAs,
  resetGates,
  retireTestUser,
} from "./helpers";

// 개설 폼의 달력 입력(SessionPicker)과, 개설 후 회차 추가·취소(개강 전·신청 없음일 때만).
// 개설강의는 강사 1인 전역 겹침 제약 때문에 서로 겹치지 않는 날짜를 쓰고, 끝나면 회차를 지운다.
const resultPopup = (page: Page, ok: boolean) => page.getByRole("alertdialog", { name: ok ? "✔ 처리되었습니다" : "✖ 실패했습니다" });

test.describe("개설 폼 달력", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let courseName: string;

  test.beforeEach(async ({ page }) => {
    await resetGates();
    adminUser = await createTestUser({ role: "ADMIN", name: "관리자" });
    courseName = `E2E달력-${randomUUID().slice(0, 8)}`;
    const { data: course } = await admin.from("courses").insert({ name: courseName, category: "IT" }).select("id").single();
    courseId = course!.id;
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto("/admin/course-offerings");
  });

  test.afterEach(async () => {
    const { data: offerings } = await admin.from("course_offerings").select("id").eq("course_id", courseId);
    for (const o of offerings ?? []) {
      try {
        require("child_process").execFileSync("docker", [
          "exec",
          "supabase_db_class-desk",
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-c",
          `delete from public.course_sessions where course_offering_id = '${o.id}';
           delete from public.course_offering_events where course_offering_id = '${o.id}';`,
        ]);
      } catch {}
      await admin.from("course_offerings").delete().eq("id", o.id);
    }
    if (courseId) await admin.from("courses").delete().eq("id", courseId);
    if (adminUser) await retireTestUser(adminUser);
  });

  // 달력은 이번 달에서 시작한다 — 보이지 않는 날짜면 그 달 쪽으로(앞/뒤) 넘긴다.
  async function clickDate(page: Page, date: string) {
    const picker = page.getByTestId("session-picker");
    const cell = picker.locator(`[data-date="${date}"]`);
    const target = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
    for (let i = 0; i < 12 && !(await cell.isVisible()); i++) {
      const title = (await picker.getByTestId("calendar-title").textContent()) ?? "";
      const m = /(\d{4})년 (\d{1,2})월/.exec(title);
      const current = m ? Number(m[1]) * 12 + Number(m[2]) : target;
      await picker.getByRole("button", { name: target > current ? "다음 달" : "이전 달" }).click();
    }
    await cell.click();
  }

  test("날짜를 눌러 고르고(해제 포함) 회차마다 시각을 다르게 해서 개설하면 날짜 행으로 저장되고 개강·종료가 계산된다", async ({ page }) => {
    const picker = page.getByTestId("session-picker");
    await expect(picker.getByTestId("picker-summary")).toContainText("아직 고른 날짜가 없습니다");

    const d1 = kstDateInput(40);
    const d2 = kstDateInput(47);
    const d3 = kstDateInput(54);
    await picker.getByTestId("base-start").fill("19:00");
    await picker.getByTestId("base-end").fill("21:00");
    await clickDate(page, d1);
    await clickDate(page, d2);
    await clickDate(page, d3);
    await expect(picker.getByTestId("picker-summary")).toContainText("총 3회");

    // 눌렀던 날짜를 다시 누르면 해제된다 / 행의 ✕로도 뺄 수 있다
    await clickDate(page, d2);
    await expect(picker.getByTestId("picker-summary")).toContainText("총 2회");
    await expect(picker.locator(`[data-date="${d2}"]`)).toHaveAttribute("aria-pressed", "false");
    await clickDate(page, d2);
    await picker.getByRole("button", { name: `${d3} 빼기` }).click();
    await expect(picker.getByTestId("picker-summary")).toContainText("총 2회");
    await clickDate(page, d3);

    // 첫 회차만 시각을 다르게
    await picker.getByLabel(`${d1} 시작 시각`).fill("10:30");
    await picker.getByLabel(`${d1} 종료 시각`).fill("12:00");

    await page.locator('select[name="course_id"]').selectOption({ label: courseName });
    await page.locator('input[name="label"]').fill("달력1기");
    await page.locator('input[name="capacity"]').fill("5");
    await page.locator('input[name="price"]').fill("10000");
    await page.locator('input[name="recruit_opens_at"]').fill(kstLocalInput(-1));
    await page.getByRole("button", { name: "등록" }).click();
    await expect(page.locator("tbody tr", { hasText: courseName })).toBeVisible();

    const { data: offering } = await admin.from("course_offerings").select("id, opens_at, ends_at").eq("course_id", courseId).single();
    const { data: rows } = await admin
      .from("course_sessions")
      .select("session_date, start_time, end_time")
      .eq("course_offering_id", offering!.id)
      .order("session_date");
    expect(rows).toEqual([
      { session_date: d1, start_time: "10:30:00", end_time: "12:00:00" },
      { session_date: d2, start_time: "19:00:00", end_time: "21:00:00" },
      { session_date: d3, start_time: "19:00:00", end_time: "21:00:00" },
    ]);
    expect(new Date(offering!.opens_at).toISOString()).toBe(new Date(`${d1}T10:30:00+09:00`).toISOString());
    expect(new Date(offering!.ends_at!).toISOString()).toBe(new Date(`${d3}T21:00:00+09:00`).toISOString());
  });

  test("요일 채우기는 손으로 고른 날짜에 더해지고, 날짜를 하나도 안 고르면 서버가 거부한다", async ({ page }) => {
    await page.waitForLoadState("networkidle");
    const picker = page.getByTestId("session-picker");
    // 요일 채우기: 요일 없이 누르면 안내, 채우면 더해지고 중복은 늘지 않는다
    const fillBtn = picker.getByTestId("fill-button");
    await fillBtn.waitFor({ state: "visible" });
    await fillBtn.click();
    await expect(picker.getByTestId("picker-message")).toContainText("요일");
    const from = kstDateInput(60);
    const until = kstDateInput(66); // 7일 구간 → 요일마다 정확히 1개
    const dow = new Date(`${from}T00:00:00Z`).getUTCDay();
    await clickDate(page, kstDateInput(61));
    await picker.getByTestId(`fill-day-${dow}`).check();
    await picker.getByTestId("fill-from").fill(from);
    await picker.getByTestId("fill-until").fill(until);
    await picker.getByTestId("fill-button").click();
    await expect(picker.getByTestId("picker-summary")).toContainText("총 2회");
    // 중복 날짜는 더해지지 않는다
    await picker.getByTestId("fill-button").click();
    await expect(picker.getByTestId("picker-summary")).toContainText("총 2회");

    // 다 지우고 등록을 시도하면 서버가 거부한다
    await clickDate(page, kstDateInput(61));
    const targetDate = kstDateInput(60); // from 날짜가 dow와 일치하므로
    await clickDate(page, targetDate);
    await page.locator('select[name="course_id"]').selectOption({ label: courseName });
    await page.locator('input[name="label"]').fill("거부기");
    await page.locator('input[name="capacity"]').fill("5");
    await page.locator('input[name="price"]').fill("10000");
    await page.locator('input[name="recruit_opens_at"]').fill(kstLocalInput(-1));
    await page.getByRole("button", { name: "등록" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "회차를 1개 이상" })).toBeVisible();
    const { data: none } = await admin.from("course_offerings").select("id").eq("course_id", courseId);
    expect(none ?? []).toHaveLength(0);
  });

  test("다른 수업과 같은 날짜·시간대가 겹치면 등록이 거부되고 개설강의가 남지 않는다", async ({ page }) => {
    const date = kstDateInput(75);
    const { data: other } = await admin.from("course_offerings").insert({
      course_id: courseId, label: "선점", capacity: 5, remaining_seats: 5, price: 1000, status: "OPEN",
      recruit_opens_at: new Date(Date.now() - 3_600_000).toISOString(),
      opens_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).select("id").single();
    await admin.from("course_sessions").insert({ course_offering_id: other!.id, session_date: date, start_time: "19:00", end_time: "21:00" });

    const picker = page.getByTestId("session-picker");
    await picker.getByTestId("base-start").fill("20:00");
    await picker.getByTestId("base-end").fill("22:00");
    await clickDate(page, date);
    await page.locator('select[name="course_id"]').selectOption({ label: courseName });
    await page.locator('input[name="label"]').fill("겹침기");
    await page.locator('input[name="capacity"]').fill("5");
    await page.locator('input[name="price"]').fill("10000");
    await page.locator('input[name="recruit_opens_at"]').fill(kstLocalInput(-1));
    await page.getByRole("button", { name: "등록" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "이미 있는 다른 수업의 회차와 겹칩니다" })).toBeVisible({ timeout: 30_000 });
    const { data: made } = await admin.from("course_offerings").select("id").eq("course_id", courseId).eq("label", "겹침기");
    expect(made ?? []).toHaveLength(0);
  });

  test("C-1: N회 채우기로 단기 회차를 만들고, 첫 행 '나머지도 같은 시간' 체크 및 개별 행 시각 수정이 동작한다", async ({ page }) => {
    await page.waitForLoadState("networkidle");
    const picker = page.getByTestId("session-picker");

    // 시작일(80일 후)과 요일 확인
    const from = kstDateInput(80);
    const dow = new Date(`${from}T00:00:00Z`).getUTCDay();
    // dow 요일 체크, 시작일 입력, N회 = 3 입력
    await picker.getByTestId(`fill-day-${dow}`).check();
    await picker.getByTestId("fill-from").fill(from);
    await picker.getByTestId("fill-count").fill("3");
    await picker.getByTestId("fill-button").click();

    await expect(picker.getByTestId("picker-summary")).toContainText("총 3회");

    // 첫 행에 '나머지도 같은 시간' 체크박스가 노출됨
    const syncCheckbox = picker.getByTestId("sync-times-checkbox");
    await expect(syncCheckbox).toBeVisible();
    await expect(syncCheckbox).not.toBeChecked();

    // 체크박스 체크 -> 첫 행 기본 시각(19:00~21:00)이 전체 행에 일괄 적용됨
    await syncCheckbox.check();
    await expect(syncCheckbox).toBeChecked();

    // 첫 행 시각을 14:00~16:00으로 변경하면 나머지 행들도 14:00~16:00으로 자동 동기화됨
    await picker.getByLabel(`${from} 시작 시각`).fill("14:00");
    await picker.getByLabel(`${from} 종료 시각`).fill("16:00");

    // 두 번째 행과 세 번째 행의 시작 시각이 14:00으로 바뀌었는지 확인
    const rows = picker.getByTestId("picker-rows").locator("li");
    await expect(rows.nth(1).locator('input[type="time"]').first()).toHaveValue("14:00");
    await expect(rows.nth(2).locator('input[type="time"]').first()).toHaveValue("14:00");

    // 두 번째 행만 개별적으로 15:00으로 수정 -> (일부 행이 다름) 안내 표시가 뜨고 체크는 유지됨
    await rows.nth(1).locator('input[type="time"]').first().fill("15:00");
    await expect(picker.getByTestId("sync-deviation-notice")).toContainText("일부 행이 다름");
    await expect(syncCheckbox).toBeChecked();
  });
});


test.describe("개설 후 회차 추가·취소", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let d1: string;
  let d2: string;

  test.beforeEach(async ({ page }) => {
    await resetGates();
    adminUser = await createTestUser({ role: "ADMIN", name: "관리자" });
    student = await createTestUser({ role: "STUDENT", name: "학생" });
    ({ courseId, offeringId } = await createCourseOffering({ price: 10_000, capacity: 5 }));
    d1 = kstDateInput(100);
    d2 = kstDateInput(107);
    const { error } = await admin.from("course_sessions").insert([
      { course_offering_id: offeringId, session_date: d1, start_time: "19:00", end_time: "21:00" },
      { course_offering_id: offeringId, session_date: d2, start_time: "19:00", end_time: "21:00" },
    ]);
    expect(error).toBeNull();
    await loginAs(page, adminUser.email, adminUser.password);
  });

  test.afterEach(async () => {
    if (student) await retireTestUser(student);
    if (adminUser) await retireTestUser(adminUser);
    if (offeringId && courseId) {
      await admin.from("course_sessions").delete().eq("course_offering_id", offeringId);
      await deleteCourseOffering(offeringId, courseId);
    }
  });

  test("회차를 추가하면 목록과 개강이 갱신되고, 취소하면 비활성+사유로 남으며, 마지막 회차는 취소할 수 없다", async ({ page }) => {
    await page.goto(`/admin/course-offerings/${offeringId}`);
    const section = page.getByTestId("sessions-section");
    await expect(section).toContainText("19:00~21:00");

    // 추가: 더 이른 날짜 → 개강이 앞당겨진다
    const early = kstDateInput(95);
    await expect(async () => {
      await section.getByRole("button", { name: "회차 추가", exact: true }).click();
      await expect(page.getByRole("alertdialog").filter({ hasText: "개강 전이고 신청이 없는 수업" })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const add = page.getByRole("alertdialog").filter({ hasText: "개강 전이고 신청이 없는 수업" });
    await add.locator('input[name="date"]').fill(early);
    await add.locator('input[name="start"]').fill("09:00");
    await add.locator('input[name="end"]').fill("10:00");
    await add.locator('input[name="reason"]').fill("e2e 보강");
    await add.getByRole("button", { name: "회차 추가 확정" }).click();
    await expect(resultPopup(page, true)).toBeVisible({ timeout: 30_000 });
    await resultPopup(page, true).getByRole("button", { name: "확인" }).click();
    const { data: after } = await admin.from("course_offerings").select("opens_at").eq("id", offeringId).single();
    expect(new Date(after!.opens_at).toISOString()).toBe(new Date(`${early}T09:00:00+09:00`).toISOString());
    await expect(section.locator("li")).toHaveCount(3);

    // 같은 시간대를 또 추가하면 거부 문구
    await section.getByRole("button", { name: "회차 추가", exact: true }).click();
    const again = page.getByRole("alertdialog").filter({ hasText: "개강 전이고 신청이 없는 수업" });
    await again.locator('input[name="date"]').fill(early);
    await again.locator('input[name="start"]').fill("09:30");
    await again.locator('input[name="end"]').fill("10:30");
    await again.locator('input[name="reason"]').fill("e2e 겹침");
    await again.getByRole("button", { name: "회차 추가 확정" }).click();
    await expect(resultPopup(page, false)).toContainText("이미 다른 회차");
    await resultPopup(page, false).getByRole("button", { name: "확인" }).click();

    // 취소: 방금 추가한 회차(첫 항목)
    await section.locator("li").first().getByRole("button", { name: "취소" }).click();
    const cancel = page.getByRole("alertdialog").filter({ hasText: "이 회차를 취소할까요?" });
    await cancel.locator('input[name="reason"]').fill("e2e 보강 취소");
    await cancel.getByRole("button", { name: "회차 취소 확정" }).click();
    await expect(resultPopup(page, true)).toBeVisible({ timeout: 30_000 });
    await resultPopup(page, true).getByRole("button", { name: "확인" }).click();
    await expect(section).toContainText("(비활성: e2e 보강 취소)");
    const { data: reopened } = await admin.from("course_offerings").select("opens_at").eq("id", offeringId).single();
    expect(new Date(reopened!.opens_at).toISOString()).toBe(new Date(`${d1}T19:00:00+09:00`).toISOString());

    // 남은 회차 둘 중 하나를 취소한 뒤 마지막 하나는 취소 불가
    const active = section.locator("li", { has: page.getByRole("button", { name: "취소" }) });
    await active.first().getByRole("button", { name: "취소" }).click();
    const c2 = page.getByRole("alertdialog").filter({ hasText: "이 회차를 취소할까요?" });
    await c2.locator('input[name="reason"]').fill("e2e 하나 더");
    await c2.getByRole("button", { name: "회차 취소 확정" }).click();
    await resultPopup(page, true).getByRole("button", { name: "확인" }).click();
    await active.first().getByRole("button", { name: "취소" }).click();
    const c3 = page.getByRole("alertdialog").filter({ hasText: "이 회차를 취소할까요?" });
    await c3.locator('input[name="reason"]').fill("e2e 마지막");
    await c3.getByRole("button", { name: "회차 취소 확정" }).click();
    await expect(resultPopup(page, false)).toContainText("마지막 남은 회차");
  });

  test("신청이 있거나 개강 후이면 추가·취소 버튼 대신 이유가 보인다", async ({ page }) => {
    await createPendingOrder(student.id, offeringId, 10_000);
    await page.goto(`/admin/course-offerings/${offeringId}`);
    const section = page.getByTestId("sessions-section");
    await expect(section.getByTestId("sessions-lock")).toContainText("신청(승인 대기·승인됨)이 있는 수업은 개별 추가·취소가 아니라");
    await expect(section.getByRole("button", { name: "회차 추가", exact: true })).toHaveCount(0);
    await expect(section.getByRole("button", { name: "취소", exact: true })).toHaveCount(0);

    // 서버(DB 함수)도 같은 판정으로 막는다 — 화면을 우회한 호출
    const { data: sess } = await admin.from("course_sessions").select("id").eq("course_offering_id", offeringId).limit(1).single();
    const { data: anyUser } = await admin.from("users").select("id").limit(1).single();
    const direct = await admin.rpc("cancel_course_session", {
      p_session_id: sess!.id,
      p_actor: anyUser!.id,
      p_actor_role: "ADMIN",
      p_reason: "우회",
    });
    expect(direct.error?.message).toContain("신청(승인 대기·승인됨)이 있는");

    // 신청이 없어도 개강했으면 잠긴다
    await admin.from("orders").update({ status: "CANCELLED", cancelled_at: new Date().toISOString() }).eq("course_offering_id", offeringId);
    await admin.from("course_offerings").update({ opens_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", offeringId);
    await page.reload();
    await expect(page.getByTestId("sessions-lock")).toContainText("개강한 수업의 일정은 바꿀 수 없습니다");
  });
});
