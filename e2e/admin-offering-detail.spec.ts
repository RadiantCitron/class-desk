import { test, expect, type Page } from "@playwright/test";
import {
  admin,
  createApprovedOrder,
  createCourseOffering,
  createPendingOrder,
  createTestUser,
  deleteCourseOffering,
  loginAs,
  retireTestUser,
} from "./helpers";

// U 단계 5 — 관리자 개설강의 상세 페이지(읽기 전용: "어드민이 개설강의를
// 조회할 수 없다. 무슨 강의인지 세부내용을 볼 수 없다"). 과목명은 테스트마다 고유(createCourseOffering).
test.describe("관리자 개설강의 상세", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let studentA: Awaited<ReturnType<typeof createTestUser>>;
  let studentB: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let courseName: string;
  let pendingOrderId: string;
  let approvedOrderId: string;

  test.beforeEach(async ({ page }) => {
    adminUser = await createTestUser({ role: "ADMIN", name: "관리자" });
    studentA = await createTestUser({ role: "STUDENT", name: "학생에이", phone: "010-1111-1111" });
    studentB = await createTestUser({ role: "STUDENT", name: "학생비", phone: "010-2222-2222" });
    ({ courseId, offeringId, courseName } = await createCourseOffering({ price: 30_000, capacity: 5 }));
    await admin
      .from("course_offerings")
      .update({ location: "디스코드 1번 방" })
      .eq("id", offeringId);
    // 회차는 날짜 1행이다. 2099-12-29는 화요일 — 다른 시험의 회차와 겹치지 않는 먼 날짜.
    const { error: sessionError } = await admin.from("course_sessions").insert({
      course_offering_id: offeringId,
      session_date: "2099-12-29",
      start_time: "19:00",
      end_time: "21:00",
    });
    expect(sessionError).toBeNull();
    pendingOrderId = await createPendingOrder(studentA.id, offeringId, 30_000);
    approvedOrderId = await createApprovedOrder(studentB.id, offeringId, 30_000);
    await loginAs(page, adminUser.email, adminUser.password);
  });

  test.afterEach(async () => {
    if (studentA) await retireTestUser(studentA);
    if (studentB) await retireTestUser(studentB);
    if (adminUser) await retireTestUser(adminUser);
    if (offeringId && courseId) {
      await admin.from("course_sessions").delete().eq("course_offering_id", offeringId);
      await deleteCourseOffering(offeringId, courseId);
    }
  });

  test("목록의 '상세' 링크로 들어가면 개설강의의 기본 정보와 일정이 보인다", async ({ page }) => {
    await page.goto("/admin/course-offerings");
    const row = page.locator("tbody tr", { hasText: courseName });
    await row.getByRole("link", { name: "상세" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/course-offerings/${offeringId}$`));

    await expect(page.getByRole("heading", { level: 1 })).toContainText(courseName);
    const basic = page.locator("section", { has: page.getByRole("heading", { name: "기본 정보" }) });
    await expect(basic).toContainText("E2E기");
    await expect(basic).toContainText("모집중");
    await expect(basic).toContainText("30,000원");
    await expect(basic).toContainText("디스코드 1번 방");
    await expect(basic).toContainText("자동승인");

    const schedule = page.locator("section", { has: page.getByRole("heading", { name: "일정" }) });
    await expect(schedule).toContainText("12/29(화) 19:00~21:00");
  });

  test("신청·결제 현황 — 상태별 집계와 주문 표(행 링크)가 보인다", async ({ page }) => {
    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(page.getByTestId("count-PENDING")).toHaveText("1");
    await expect(page.getByTestId("count-APPROVED_UNPAID")).toHaveText("1");
    await expect(page.getByTestId("count-PAID")).toHaveText("0");
    await expect(page.getByTestId("count-REFUNDED")).toHaveText("0");

    const orders = page.locator("section", { has: page.getByRole("heading", { name: "신청·결제 현황" }) });
    await expect(orders).toContainText(studentA.email);
    await expect(orders).toContainText(studentB.email);
    await expect(orders).toContainText("전체 2건");

    await orders.locator("tbody tr", { hasText: studentB.email }).getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp(`/admin/orders/${approvedOrderId}$`));
    expect(pendingOrderId).not.toBe(approvedOrderId);
  });

  test("좌석 — 점유 좌석과 살아 있는 신청 수가 다르면 점검 문구가 뜨고, 맞으면 사라진다", async ({ page }) => {
    // 테스트 도구가 좌석 예약 없이 주문을 직접 만들었으니 점유 0 ≠ 살아 있는 신청 2.
    await page.goto(`/admin/course-offerings/${offeringId}`);
    const seats = page.locator("section", { has: page.getByRole("heading", { name: "좌석" }) });
    await expect(seats).toContainText("정원 5");
    await expect(seats).toContainText("좌석 점검 필요");

    await admin.from("course_offerings").update({ remaining_seats: 3 }).eq("id", offeringId);
    await page.reload();
    await expect(seats).toContainText("점유 2");
    await expect(seats).not.toContainText("좌석 점검 필요");
  });

  test("삭제된 개설강의도 직접 주소로 열람할 수 있고 '삭제됨' 배너가 뜬다", async ({ page }) => {
    await admin
      .from("course_offerings")
      .update({
        deleted_at: new Date().toISOString(),
        deleted_reason: "e2e 삭제 사유 확인",
        deleted_by: adminUser.id,
      })
      .eq("id", offeringId);
    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(courseName);
    await expect(page.getByText("삭제된 개설강의입니다")).toBeVisible();
    await expect(page.getByText("e2e 삭제 사유 확인")).toBeVisible();
  });

  test("상세의 작업 영역 — 마감하면 상태가 \"마감\"으로, 재개하면 \"모집중\"으로 이 화면에서 바로 바뀐다", async ({ page }) => {
    await page.goto(`/admin/course-offerings/${offeringId}`);
    const basic = page.locator("section", { has: page.getByRole("heading", { name: "기본 정보" }) });
    const work = page.locator("section", { has: page.getByRole("heading", { name: "작업" }) });
    await expect(basic).toContainText("모집중");

    await work.getByPlaceholder("마감 사유").fill("e2e 상세 마감");
    await work.getByRole("button", { name: "마감", exact: true }).click();
    await expect(basic).toContainText("마감");
    await expect(basic).toContainText("사유: e2e 상세 마감");

    await work.getByPlaceholder("재개 사유").fill("e2e 상세 재개");
    await work.getByRole("button", { name: "재개", exact: true }).click();
    await expect(basic).toContainText("모집중");
    await expect(basic).toContainText("사유: e2e 상세 재개");
  });

  // ---- U 단계 6: 수정 ----
  const editDialog = (page: Page) => page.getByRole("alertdialog").filter({ hasText: "개설강의 수정" });
  async function openEdit(page: Page, targetOfferingId: string = offeringId) {
    await page.goto(`/admin/course-offerings/${targetOfferingId}`);
    const work = page.locator("section", { has: page.getByRole("heading", { name: "작업" }) });
    // 페이지가 준비(hydration)되기 전에 누르면 모달이 안 열리므로 열릴 때까지 누르기를 재시도한다.
    await expect(async () => {
      await work.getByRole("button", { name: "수정", exact: true }).click();
      await expect(editDialog(page)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    return editDialog(page);
  }
  const resultPopup = (page: Page, ok: boolean) =>
    page.getByRole("alertdialog", { name: ok ? "✔ 처리되었습니다" : "✖ 실패했습니다" });

  test("개설강의 수정 — 라벨·위치·정원을 바꾸면 결과 팝업이 변경 내용을 알리고 화면과 DB에 반영된다", async ({ page }) => {
    // F-9: 신청자가 있는 개설강의는 장소 변경이 '수업 조건 변경'으로 제한되므로,
    // 신청자가 없는 별도 개설강의로 라벨·위치·정원 수정을 검증한다.
    const fresh = await createCourseOffering({ price: 30_000, capacity: 5 });
    await admin.from("course_offerings").update({ location: "디스코드 1번 방" }).eq("id", fresh.offeringId);
    await admin.from("course_sessions").insert({
      course_offering_id: fresh.offeringId,
      session_date: "2099-12-30",
      start_time: "19:00",
      end_time: "21:00",
    });

    try {
      const dialog = await openEdit(page, fresh.offeringId);
      await dialog.locator('input[name="label"]').fill("수정기");
      await dialog.locator('input[name="location"]').fill("새 위치 방");
      await dialog.locator('input[name="capacity"]').fill("8");
      await dialog.locator('textarea[name="reason"], input[name="reason"]').fill("e2e 수정");
      await dialog.getByRole("button", { name: "수정 저장" }).click();

      const popup = resultPopup(page, true);
      await expect(popup).toBeVisible({ timeout: 30_000 });
      await expect(popup).toContainText("개설강의를 수정했습니다");
      await expect(popup).toContainText("정원: 5 → 8");
      await expect(popup).toContainText("회차 라벨: E2E기 → 수정기");
      await expect(popup).toContainText("위치: 디스코드 1번 방 → 새 위치 방");
      await expect(editDialog(page)).toBeHidden();
      await popup.getByRole("button", { name: "확인" }).click();

      const basic = page.locator("section", { has: page.getByRole("heading", { name: "기본 정보" }) });
      await expect(basic).toContainText("수정기");
      await expect(basic).toContainText("새 위치 방");
      const { data } = await admin
        .from("course_offerings")
        .select("label, location, capacity, remaining_seats, price")
        .eq("id", fresh.offeringId)
        .single();
      expect(data).toMatchObject({ label: "수정기", location: "새 위치 방", capacity: 8, remaining_seats: 8, price: 30_000 });
    } finally {
      await admin.from("course_sessions").delete().eq("course_offering_id", fresh.offeringId);
      await deleteCourseOffering(fresh.offeringId, fresh.courseId);
    }
  });

  test("개설강의 수정 — 정원을 점유 좌석 아래로 줄이면 실패 팝업이 이유를 알리고 값은 그대로다", async ({ page }) => {
    await admin.from("course_offerings").update({ remaining_seats: 3 }).eq("id", offeringId); // 점유 2
    const dialog = await openEdit(page);
    await dialog.locator('input[name="capacity"]').fill("1");
    await dialog.locator('textarea[name="reason"], input[name="reason"]').fill("e2e 정원 과감소");
    await dialog.getByRole("button", { name: "수정 저장" }).click();

    const popup = resultPopup(page, false);
    await expect(popup).toBeVisible({ timeout: 30_000 });
    await expect(popup).toContainText("점유 좌석(2명)");
    await popup.getByRole("button", { name: "확인" }).click();
    const { data } = await admin.from("course_offerings").select("capacity, remaining_seats").eq("id", offeringId).single();
    expect(data).toMatchObject({ capacity: 5, remaining_seats: 3 });
  });

  test("개설강의 수정 — 바꾼 게 없으면 '변경된 값이 없습니다'로 알린다", async ({ page }) => {
    const dialog = await openEdit(page);
    await dialog.locator('textarea[name="reason"], input[name="reason"]').fill("e2e 변경 없음");
    await dialog.getByRole("button", { name: "수정 저장" }).click();
    const popup = resultPopup(page, false);
    await expect(popup).toBeVisible({ timeout: 30_000 });
    await expect(popup).toContainText("변경된 값이 없습니다");
  });

  // R-8(2026-10-02): "온라인(디스코드) 수업" 체크 — 켜면 역할 ID 필수, 저장하면 DISCORD_ROLE grant가 생기고, 끄면 사라진다.
  test("개설강의 수정 — 온라인(디스코드) 수업을 켜고 끄면 grants의 DISCORD_ROLE이 생기고 사라진다", async ({ page }) => {
    const grantsNow = async () => {
      const { data } = await admin.from("course_offerings").select("grants").eq("id", offeringId).single();
      return (data?.grants ?? []) as { type: string; discord_role_id?: string; discord_channel_id?: string }[];
    };

    // 테스트용 개설강의는 grants가 비어 있으므로, 끌 때 다른 grant가 보존되는지 보려면 먼저 하나 넣는다.
    await admin.from("course_offerings").update({ grants: [{ type: "COURSE_ACCESS" }] }).eq("id", offeringId);

    let dialog = await openEdit(page);
    await expect(dialog.getByLabel("온라인(디스코드) 수업")).not.toBeChecked();
    await expect(dialog.locator('input[name="discord_role_id"]')).toHaveCount(0);
    await dialog.getByLabel("온라인(디스코드) 수업").check();
    await expect(dialog.locator('input[name="discord_role_id"]')).toHaveAttribute("required", "");
    await dialog.locator('input[name="discord_role_id"]').fill("111122223333444455");
    await dialog.locator('input[name="discord_channel_id"]').fill("555544443333222211");
    await dialog.locator('textarea[name="reason"], input[name="reason"]').fill("온라인 전환");
    await dialog.getByRole("button", { name: "수정 저장" }).click();
    const on = resultPopup(page, true);
    await expect(on).toBeVisible({ timeout: 30_000 });
    await expect(on).toContainText("디스코드 역할");
    await on.getByRole("button", { name: "확인" }).click();
    expect((await grantsNow()).find((g) => g.type === "DISCORD_ROLE")).toMatchObject({
      discord_role_id: "111122223333444455",
      discord_channel_id: "555544443333222211",
    });

    // 다시 열면 켜진 채 값이 채워져 있고, 끄면 DISCORD_ROLE만 사라진다(다른 grant는 보존).
    dialog = await openEdit(page);
    await expect(dialog.getByLabel("온라인(디스코드) 수업")).toBeChecked();
    await expect(dialog.locator('input[name="discord_role_id"]')).toHaveValue("111122223333444455");
    await dialog.getByLabel("온라인(디스코드) 수업").uncheck();
    await expect(dialog.locator('input[name="discord_role_id"]')).toHaveCount(0);
    await dialog.locator('textarea[name="reason"], input[name="reason"]').fill("오프라인 전환");
    await dialog.getByRole("button", { name: "수정 저장" }).click();
    const off = resultPopup(page, true);
    await expect(off).toBeVisible({ timeout: 30_000 });
    await off.getByRole("button", { name: "확인" }).click();
    const after = await grantsNow();
    expect(after.some((g) => g.type === "DISCORD_ROLE")).toBe(false);
    expect(after.some((g) => g.type === "COURSE_ACCESS")).toBe(true);
  });

  test("개설강의 수정 — 신청이 있으면 가격 변경이 기존 신청에 영향 없다는 안내가 보이고, 가격을 바꿔도 기존 주문 금액은 그대로다", async ({ page }) => {
    const dialog = await openEdit(page);
    await expect(dialog).toContainText("기존 신청 2건은 이전 금액을 유지하고 새 신청부터 적용됩니다");
    await dialog.locator('input[name="price"]').fill("45000");
    await dialog.locator('textarea[name="reason"], input[name="reason"]').fill("e2e 가격 인상");
    await dialog.getByRole("button", { name: "수정 저장" }).click();
    const popup = resultPopup(page, true);
    await expect(popup).toBeVisible({ timeout: 30_000 });
    await expect(popup).toContainText("가격: 30,000원 → 45,000원");

    const { data: offering } = await admin.from("course_offerings").select("price").eq("id", offeringId).single();
    expect(offering?.price).toBe(45_000);
    const { data: order } = await admin.from("orders").select("final_amount").eq("id", approvedOrderId).single();
    expect(order?.final_amount).toBe(30_000);
  });

  test("개설강의 수정 — 개강·종료는 입력이 아니라 회차에서 계산된 값이 한국 시간으로 읽기 전용으로 보이고, 다른 항목을 고쳐도 DB 값이 그대로다", async ({ page }) => {
    // 2026-11-01T01:00:00Z = 한국 2026-11-01 10:00 (계산 캐시 값을 직접 맞춰 표시 변환을 본다)
    await admin
      .from("course_offerings")
      .update({ opens_at: "2026-11-01T01:00:00Z", ends_at: "2026-12-01T01:00:00Z" })
      .eq("id", offeringId);
    const dialog = await openEdit(page);
    await expect(dialog.locator('input[name="opens_at"]')).toHaveCount(0);
    await expect(dialog.locator('input[name="ends_at"]')).toHaveCount(0);
    await expect(dialog.getByTestId("derived-schedule")).toContainText("2026-11-01 10:00");
    await expect(dialog.getByTestId("derived-schedule")).toContainText("2026-12-01 10:00");

    await dialog.locator('input[name="label"]').fill("시각불변");
    await dialog.locator('textarea[name="reason"], input[name="reason"]').fill("e2e 시각 불변");
    await dialog.getByRole("button", { name: "수정 저장" }).click();
    await expect(resultPopup(page, true)).toBeVisible({ timeout: 30_000 });
    await resultPopup(page, true).getByRole("button", { name: "확인" }).click();
    const { data: same } = await admin.from("course_offerings").select("opens_at, ends_at, label").eq("id", offeringId).single();
    expect(same?.label).toBe("시각불변");
    expect(new Date(same!.opens_at).toISOString()).toBe("2026-11-01T01:00:00.000Z");
    expect(new Date(same!.ends_at!).toISOString()).toBe("2026-12-01T01:00:00.000Z");
  });

  test("목록의 자동승인 토글은 새 수정 경로를 거쳐도 그대로 동작한다", async ({ page }) => {
    await page.goto("/admin/course-offerings");
    const row = page.locator("tbody tr", { hasText: courseName });
    const checkbox = row.locator('input[name="auto_approve"]');
    await expect(async () => {
      await checkbox.check();
      await row.getByRole("button", { name: "저장" }).click();
      const { data } = await admin.from("course_offerings").select("auto_approve").eq("id", offeringId).single();
      expect(data?.auto_approve).toBe(true);
    }).toPass({ timeout: 20_000 });
    const { data: logs } = await admin
      .from("audit_logs")
      .select("action")
      .eq("target_id", offeringId)
      .eq("action", "COURSE_OFFERING_UPDATE");
    expect((logs ?? []).length).toBeGreaterThan(0);
  });

  test("폐강된 개설강의에는 수정 버튼 대신 이유가 보인다", async ({ page }) => {
    await admin
      .from("course_offerings")
      .update({ status: "CANCELLING", status_reason: "e2e", status_changed_by: adminUser.id, status_changed_at: new Date().toISOString() })
      .eq("id", offeringId);
    await page.goto(`/admin/course-offerings/${offeringId}`);
    const work = page.locator("section", { has: page.getByRole("heading", { name: "작업" }) });
    await expect(work.getByRole("button", { name: "수정", exact: true })).toHaveCount(0);
    await expect(work).toContainText("폐강된 개설강의는 수정할 수 없습니다");
  });

  test("없는 개설강의 주소는 '찾을 수 없습니다'를 보여 준다", async ({ page }) => {
    await page.goto("/admin/course-offerings/00000000-0000-0000-0000-000000000000");
    await expect(page.getByRole("heading", { name: "개설강의를 찾을 수 없습니다" })).toBeVisible();
  });

  test("학생은 이 주소에 들어갈 수 없다(ADMIN 전용)", async ({ page }) => {
    await loginAs(page, studentA.email, studentA.password);
    await page.goto(`/admin/course-offerings/${offeringId}`);
    await expect(page).not.toHaveURL(new RegExp(`/admin/course-offerings/`));
  });
});
