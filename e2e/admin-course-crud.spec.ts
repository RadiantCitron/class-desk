import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { createTestUser, retireTestUser, createPendingOrder, loginAs, admin, reloadUntil, closeTestOrder, kstLocalInput, kstDateInput, fillSessionPicker } from "./helpers";

// 가장 복잡한 폼(요일별 회차 + 조건부 약관 체크박스 + EXCLUDE 제약)이라
// 실제 클릭으로 검증한다.
test.describe("관리자 — 강의(과목)/개설강의 CRUD (실제 폼 제출)", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;

  test.beforeEach(async ({ page }) => {
    adminUser = await createTestUser({ role: "ADMIN" });
    await loginAs(page, adminUser.email, adminUser.password);
  });

  test.afterEach(async () => {
    await retireTestUser(adminUser);
  });

  test("강의(과목) 등록 폼 제출 → 목록에 이름·종류가 반영된다", async ({ page }) => {
    const courseName = `E2E과목-${randomUUID().slice(0, 8)}`;

    await page.goto("/admin/courses");
    await page.getByPlaceholder("강의명").fill(courseName);
    await page.getByPlaceholder(/강의종류/).fill("IT-E2E");
    await page.getByRole("button", { name: "등록" }).click();

    const row = page.locator("tbody tr", { hasText: courseName });
    await expect(row).toBeVisible();
    await expect(row).toContainText("IT-E2E");

    await row.getByPlaceholder("삭제 사유").fill("E2E 정리");
    await row.getByRole("button", { name: "삭제" }).click();
    await expect(page.locator("tbody tr", { hasText: courseName })).toHaveCount(0);
  });

  test("개설강의 등록: 반복요일 2개 + 조건부 약관 1개를 선택하면 목록에 그대로 반영된다", async ({
    page,
  }) => {
    const courseName = `E2E과목-${randomUUID().slice(0, 8)}`;
    const { data: course } = await admin
      .from("courses")
      .insert({ name: courseName, category: "IT" })
      .select("id")
      .single();

    await page.goto("/admin/course-offerings");
    await page.locator('select[name="course_id"]').selectOption({ label: courseName });
    await page.locator('input[name="label"]').fill("E2E 1기");
    await page.locator('input[name="location"]').fill("디스코드 #general");
    await page.locator('input[name="capacity"]').fill("7");
    await page.locator('input[name="price"]').fill("123000");
    // 반복 강의 — 달력의 요일 반복 채우기(화·목)가 날짜별 회차 행으로 저장되는 경로를 검증한다.
    await page.locator('input[name="recruit_opens_at"]').fill(kstLocalInput(-1));
    await fillSessionPicker(page, { from: kstDateInput(7), until: kstDateInput(90), days: [2, 4], start: "20:00", end: "22:00" });
    await page.locator('input[name="required_terms_types"][value="AI_CROSS_BORDER_TRANSFER"]').check();
    await page.getByRole("button", { name: "등록" }).click();

    const row = page.locator("tbody tr", { hasText: courseName });
    await expect(row).toBeVisible();
    await expect(row).toContainText("7명 (잔여 7)");
    await expect(row).toContainText("123,000원");
    await expect(row).toContainText("모집중");
    await expect(row).toContainText("AI 서비스 이용을 위한 개인정보 국외이전 동의");

    const { data: offering } = await admin
      .from("course_offerings")
      .select("id, required_terms_types")
      .eq("course_id", course!.id)
      .single();
    expect(offering?.required_terms_types).toEqual(["AI_CROSS_BORDER_TRANSFER"]);

    const { data: sessions } = await admin
      .from("course_sessions")
      .select("session_date, start_time, end_time")
      .eq("course_offering_id", offering!.id)
      .order("session_date");
    // 기간(+7일~+90일) 안의 모든 화·목이 날짜 행으로 저장되고 요일/기간 패턴은 저장되지 않는다.
    const expectedDates: string[] = [];
    for (let d = 7; d <= 90; d++) {
      const date = kstDateInput(d);
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (dow === 2 || dow === 4) expectedDates.push(date);
    }
    expect(sessions?.map((s) => s.session_date)).toEqual(expectedDates);
    expect(sessions?.every((s) => s.start_time === "20:00:00" && s.end_time === "22:00:00")).toBe(true);
    const { data: derived } = await admin.from("course_offerings").select("opens_at, ends_at").eq("id", offering!.id).single();
    expect(new Date(derived!.opens_at).toISOString()).toBe(new Date(`${expectedDates[0]}T20:00:00+09:00`).toISOString());
    expect(new Date(derived!.ends_at!).toISOString()).toBe(new Date(`${expectedDates[expectedDates.length - 1]}T22:00:00+09:00`).toISOString());

    // 정리(신청 내역이 없으니 목록에서 숨기는 데 성공해야 한다 — 2026-09-11부터 삭제는 소프트
    // 삭제라 행 자체는 남는다. 완전히 치우려면 course_offerings까지 서비스롤로 직접 지워야
    // course_id를 참조하는 행이 없어져 courses도 하드 삭제할 수 있다).
    await row.getByPlaceholder("삭제 사유").fill("E2E 정리");
    await row.getByRole("button", { name: "삭제" }).click();
    await expect(page.locator("tbody tr", { hasText: courseName })).toHaveCount(0);
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
        `delete from public.course_sessions where course_offering_id = '${offering!.id}';
         delete from public.course_offering_events where course_offering_id = '${offering!.id}';`,
      ]);
    } catch {}
    await admin.from("course_offerings").delete().eq("id", offering!.id);
    await admin.from("courses").delete().eq("id", course!.id);
  });

  test("겹치는 요일·시간대의 개설강의는 저장이 거부되고 고아 데이터를 남기지 않는다", async ({
    page,
  }) => {
    const courseName = `E2E과목-${randomUUID().slice(0, 8)}`;
    const { data: course } = await admin
      .from("courses")
      .insert({ name: courseName, category: "IT" })
      .select("id")
      .single();

    // 첫 번째: 화요일 20-22시로 정상 등록.
    await page.goto("/admin/course-offerings");
    await page.locator('select[name="course_id"]').selectOption({ label: courseName });
    await page.locator('input[name="label"]').fill("A기");
    await page.locator('input[name="capacity"]').fill("5");
    await page.locator('input[name="price"]').fill("10000");
    await page.locator('input[name="recruit_opens_at"]').fill(kstLocalInput(-1));
    await fillSessionPicker(page, { from: kstDateInput(7), until: kstDateInput(90), days: [2], start: "20:00", end: "22:00" });
    await page.getByRole("button", { name: "등록" }).click();
    await expect(page.locator("tbody tr", { hasText: courseName })).toBeVisible();

    // 두 번째: 같은 화요일, 겹치는 시간대(21-23시), 겹치는 기간 — EXCLUDE 제약(course_sessions)에
    // 걸려 거부돼야 한다. 관리자 서버 액션은 실패 시 uncaught error를 던지므로(코드리뷰 확인됨,
    // app/admin/course-offerings/actions.ts) 화면에 친절한 메시지 대신 Next 에러가 뜬다 — 여기서는
    // "B기"라는 이름의 개설강의가 DB에 하나도 안 남아야 한다는 사실(원자성)만 확인한다.
    await page.locator('select[name="course_id"]').selectOption({ label: courseName });
    await page.locator('input[name="label"]').fill("B기");
    await page.locator('input[name="capacity"]').fill("5");
    await page.locator('input[name="price"]').fill("10000");
    await page.locator('input[name="recruit_opens_at"]').fill(kstLocalInput(-1));
    await fillSessionPicker(page, { from: kstDateInput(7), until: kstDateInput(90), days: [2], start: "21:00", end: "23:00" });
    await page.getByRole("button", { name: "등록" }).click().catch(() => {});
    await page.waitForTimeout(1500);

    const { data: orphan } = await admin
      .from("course_offerings")
      .select("id")
      .eq("course_id", course!.id)
      .eq("label", "B기");
    expect(orphan?.length ?? 0).toBe(0);

    // 정리 — 회차 FK가 restrict라 회차를 먼저 지운다.
    const { data: offerings } = await admin.from("course_offerings").select("id").eq("course_id", course!.id);
    const offeringIds = (offerings ?? []).map((o) => o.id);
    for (const offId of offeringIds) {
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
          `delete from public.course_sessions where course_offering_id = '${offId}';
           delete from public.course_offering_events where course_offering_id = '${offId}';`,
        ]);
      } catch {}
    }
    await admin.from("course_offerings").delete().eq("course_id", course!.id);
    await admin.from("courses").delete().eq("id", course!.id);
  });

  test("마감→재개 토글이 실제 상태를 바꾸고, 신청 내역이 있는 개설강의는 삭제가 거부된다", async ({
    page,
  }) => {
    const courseName = `E2E과목-${randomUUID().slice(0, 8)}`;
    const { data: course } = await admin
      .from("courses")
      .insert({ name: courseName, category: "IT" })
      .select("id")
      .single();
    const { data: offering } = await admin
      .from("course_offerings")
      .insert({
        course_id: course!.id,
        label: "토글기",
        capacity: 5,
        remaining_seats: 5,
        price: 10000,
        recruit_opens_at: new Date(Date.now() - 3_600_000).toISOString(),
        opens_at: new Date(Date.now() + 86_400_000).toISOString(),
        ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        status: "OPEN",
      })
      .select("id")
      .single();

    await page.goto("/admin/course-offerings");
    const row = page.locator("tbody tr", { hasText: courseName });
    await row.getByPlaceholder("마감 사유").fill("E2E 마감");
    await row.getByRole("button", { name: "마감" }).click();
    // 마감이 실제로 반영되면 이 행에 "재개" 버튼이 나타난다(화면 배지는 한글 "마감"이고, 마감 전에는 "마감" 버튼 글자가
    // 행에 이미 있어 텍스트만으로는 반영 여부를 구분할 수 없다 — 예전 "CLOSED" 단언은 폐강 모달 문구에 우연히 걸렸다).
    await expect(row.getByRole("button", { name: "재개" })).toBeVisible();

    // 재개도 마감과 마찬가지로 사유가 필수다
    // ("관리자가 바꾸는 상태 전이는 방향과 무관하게 전부 사유 필수"). 예전엔 재개는 사유 없이 됐다).
    await row.getByPlaceholder("재개 사유").fill("E2E 재개");
    await row.getByRole("button", { name: "재개" }).click();
    await expect(row).toContainText("모집중");

    // 신청 내역을 하나 만들고 삭제를 시도 — RESTRICT라 거부되어 행이 그대로 남아야 한다.
    const student = await createTestUser({ role: "STUDENT" });
    await createPendingOrder(student.id, offering!.id, 10000);

    await row.getByPlaceholder("삭제 사유").fill("E2E 삭제 시도");
    await row.getByRole("button", { name: "삭제" }).click().catch(() => {});
    // 삭제 거부(서버 액션이 오류를 던짐) 뒤 화면 전환과 새로고침이 겹치면 reload가 ERR_ABORTED로 실패하므로 재시도한다.
    await reloadUntil(page, () =>
      expect(page.locator("tbody tr", { hasText: courseName })).toBeVisible({ timeout: 5_000 }),
    );

    // 정리: 신청은 지우지 않고 반려로 닫는다. 신청이 남아 개설강의·강의는 FK RESTRICT로 지워지지 않는다 —
    // 고유한 강의명이라 다음 실행에 영향 없음, 잔여는 db:reset.
    const { data: offeringOrders } = await admin.from("orders").select("id").eq("course_offering_id", offering!.id);
    for (const o of offeringOrders ?? []) await closeTestOrder(o.id, adminUser.id);
    await retireTestUser(student);
  });
});
