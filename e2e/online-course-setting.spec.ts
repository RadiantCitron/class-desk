import { test, expect } from "@playwright/test";
import { execFileSync } from "child_process";
import {
  admin,
  createCourseOffering,
  createTestUser,
  deleteCourseOffering,
  loginAs,
  resetGates,
  retireTestUser,
  kstLocalInput,
  kstDateInput,
  fillSessionPicker,
} from "./helpers";
import { randomUUID } from "crypto";

// 개설할 때도 "온라인(디스코드) 수업" 여부를 정하고, 신청 단계도 결제 단계와 같은 판정
// (grants에 역할 ID가 있는 DISCORD_ROLE)을 따른다. 디스코드와 무관한 수업은 디스코드 연결 없이 신청할 수 있다.

test.describe("개설 폼 — 온라인(디스코드) 수업 설정", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let courseName: string;
  const createdOfferingIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    await resetGates();
    adminUser = await createTestUser({ role: "ADMIN", name: "관리자" });
    courseName = `E2E온라인-${randomUUID().slice(0, 8)}`;
    const { data: course } = await admin.from("courses").insert({ name: courseName, category: "IT" }).select("id").single();
    courseId = course!.id;
    await loginAs(page, adminUser.email, adminUser.password);
    await page.goto("/admin/course-offerings");
  });

  test.afterEach(async () => {
    if (courseId) {
      try {
        execFileSync("docker", [
          "exec",
          "supabase_db_class-desk",
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-c",
          `delete from public.course_sessions where course_offering_id in (select id from public.course_offerings where course_id = '${courseId}');
           delete from public.course_offering_events where course_offering_id in (select id from public.course_offerings where course_id = '${courseId}');
           delete from public.course_offerings where course_id = '${courseId}';
           delete from public.courses where id = '${courseId}';`,
        ]);
      } catch {}
    }
    if (adminUser) await retireTestUser(adminUser);
  });

  // 한 시험 안에서 개설강의를 여러 개 만들어도 서로 겹치지 않도록 호출마다 다른 날짜(강사 1인 전역 겹침 제약)를 쓴다.
  let slot = 0;
  async function fillBasics(page: import("@playwright/test").Page, label: string) {
    await page.locator('select[name="course_id"]').selectOption({ label: courseName });
    await page.locator('input[name="label"]').fill(label);
    await page.locator('input[name="capacity"]').fill("5");
    await page.locator('input[name="price"]').fill("10000");
    await page.locator('input[name="recruit_opens_at"]').fill(kstLocalInput(-1));
    const date = kstDateInput(7 + slot++);
    await fillSessionPicker(page, { from: date, until: date, days: [], start: "10:00", end: "12:00" });
  }

  async function grantsOf(label: string) {
    const { data } = await admin
      .from("course_offerings")
      .select("id, grants")
      .eq("course_id", courseId)
      .eq("label", label)
      .maybeSingle();
    if (data && !createdOfferingIds.includes(data.id)) createdOfferingIds.push(data.id);
    return (data?.grants ?? []) as { type: string; discord_role_id?: string; discord_channel_id?: string }[];
  }

  test("기본은 온라인 수업이 아니며 역할·채널 입력이 없고, 그대로 개설하면 DISCORD_ROLE이 없다", async ({ page }) => {
    await expect(page.getByLabel("온라인(디스코드) 수업")).not.toBeChecked();
    await expect(page.locator('input[name="discord_role_id"]')).toHaveCount(0);
    await fillBasics(page, "오프라인기");
    await page.getByRole("button", { name: "등록", exact: true }).click();
    await expect.poll(async () => (await grantsOf("오프라인기")).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const grants = await grantsOf("오프라인기");
    expect(grants.some((g) => g.type === "DISCORD_ROLE")).toBe(false);
  });

  test("온라인 수업을 체크하면 역할 ID가 필수가 되고, 개설하면 DISCORD_ROLE grant가 저장된다", async ({ page }) => {
    const role = page.locator('input[name="discord_role_id"]');
    // 페이지가 아직 준비(hydration)되기 전에 체크하면 역할 입력칸이 안 나타난다(개설강의 목록이 느릴 때 실제로 겪음, 2026-10-08) — 보일 때까지 다시 체크한다.
    await expect(async () => {
      await page.getByLabel("온라인(디스코드) 수업").uncheck();
      await page.getByLabel("온라인(디스코드) 수업").check();
      await expect(role).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(role).toHaveAttribute("required", "");
    await fillBasics(page, "온라인기");
    await role.fill("111122223333444455");
    await page.locator('input[name="discord_channel_id"]').fill("555544443333222211");
    await page.getByRole("button", { name: "등록", exact: true }).click();
    await expect.poll(async () => (await grantsOf("온라인기")).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const grants = await grantsOf("온라인기");
    expect(grants.find((g) => g.type === "DISCORD_ROLE")).toMatchObject({
      discord_role_id: "111122223333444455",
      discord_channel_id: "555544443333222211",
    });
  });
});

test.describe("신청 단계 — 디스코드 미연결 학생", () => {
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let offline: Awaited<ReturnType<typeof createCourseOffering>>;
  let online: Awaited<ReturnType<typeof createCourseOffering>>;

  test.beforeEach(async ({ page }) => {
    await resetGates();
    student = await createTestUser({ role: "STUDENT", name: "미연결", phone: "010-0000-0000" });
    // createTestUser는 디스코드를 연결해 두므로 이 학생만 연결을 끊는다.
    await admin.from("discord_accounts").delete().eq("user_id", student.id);
    offline = await createCourseOffering();
    online = await createCourseOffering();
    await admin
      .from("course_offerings")
      .update({ grants: [{ type: "COURSE_ACCESS" }, { type: "DISCORD_ROLE", discord_role_id: "111122223333444455" }] })
      .eq("id", online.offeringId);
    await loginAs(page, student.email, student.password);
  });

  test.afterEach(async () => {
    await retireTestUser(student);
    await deleteCourseOffering(offline.offeringId, offline.courseId);
    await deleteCourseOffering(online.offeringId, online.courseId);
  });

  test("디스코드와 무관한 수업과 온라인(디스코드) 수업 모두 신청 가능하며, 온라인 수업은 결제 전 디스코드 안내가 표시된다", async ({ page }) => {
    await page.goto("/student");
    // 온라인 개설강의가 있으므로 상단에 온라인 수업 디스코드 연결 안내 배너가 보인다.
    await expect(page.getByText("온라인(디스코드) 수업은 디스코드 계정을 연결해야 신청할 수 있습니다.")).toBeVisible();

    const offlineRow = page.locator("li", { hasText: offline.courseName });
    const onlineRow = page.locator("li", { hasText: online.courseName });
    await expect(offlineRow.getByRole("link", { name: "신청하기" })).toBeVisible();
    await expect(onlineRow).toContainText("온라인(디스코드)");
    // F-5: 온라인 수업이어도 미연결 학생의 신청을 막지 않는다(신청하기 링크 노출 및 결제 전 연결 안내 표시).
    await expect(onlineRow.getByRole("link", { name: "신청하기" })).toBeVisible();
    await expect(onlineRow).toContainText("결제 전에 디스코드 연결이 필요합니다");

    // 온라인 수업의 신청 주소로 직접 들어가도 리다이렉트되지 않고 안내 문구와 함께 신청 화면이 열린다.
    await page.goto(`/student/apply/${online.offeringId}`);
    await expect(page).toHaveURL(`/student/apply/${online.offeringId}`);
    await expect(page.getByText("디스코드로 진행하는 강의입니다 — 결제 전에 디스코드 연결이 필요합니다")).toBeVisible();

    // 오프라인 수업은 그대로 신청된다.
    await page.goto("/student");
    await offlineRow.getByRole("link", { name: "신청하기" }).click();
    await expect(page).toHaveURL(new RegExp(`/student/apply/${offline.offeringId}`));
    await page.getByRole("button", { name: "신청하기" }).click();
    await expect(page).toHaveURL("/student");
    const { data: order } = await admin
      .from("orders")
      .select("status")
      .eq("user_id", student.id)
      .eq("course_offering_id", offline.offeringId)
      .single();
    expect(order?.status).toBe("PENDING");
  });

  test("온라인 수업이 없으면 디스코드 미연결 학생이어도 상단 안내 배너가 뜨지 않는다", async ({ page }) => {
    // 온라인 개설강의를 오프라인 강의로 변경하여 온라인 수업이 없는 상태를 만든다.
    await admin.from("course_offerings").update({ grants: [{ type: "COURSE_ACCESS" }] }).eq("id", online.offeringId);
    await page.goto("/student");
    await expect(page.getByText("디스코드 계정을 연결해야")).toHaveCount(0);
    const offlineRow = page.locator("li", { hasText: offline.courseName });
    await expect(offlineRow.getByRole("link", { name: "신청하기" })).toBeVisible();
  });
});
