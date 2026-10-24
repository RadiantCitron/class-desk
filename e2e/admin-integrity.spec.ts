import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import {
  createTestUser,
  retireTestUser,
  createCourseOffering,
  deleteCourseOffering,
  createPendingOrder,
  loginAs,
  admin,
  closeTestOrder,
  kstLocalInput,
  kstDateInput,
  fillSessionPicker,
} from "./helpers";

// 인증/결제 흐름은 제외하고, 관리자/수강생 핵심 기능(생성·승인·반려·취소·삭제·조회)이 실제로
// DB 정합성을 지키는지 확인한다(수정/삭제 기능이 가장 위험하다). 지금까지 자동화된 적 없던 화면
// (감사로그/DLQ)과, 새로 도입된 것(카탈로그 소프트 삭제, 무결성 점검 계층)의
// 실제 동작을 여기서 처음 실제 브라우저 클릭으로 검증한다.
test.describe("관리자 — 감사로그/DLQ 화면", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;

  test.beforeEach(async ({ page }) => {
    adminUser = await createTestUser({ role: "ADMIN" });
    await loginAs(page, adminUser.email, adminUser.password);
  });

  test.afterEach(async () => {
    await retireTestUser(adminUser);
  });

  test("관리자 조작이 감사로그 화면에 실제로 기록되어 보인다", async ({ page }) => {
    const name = `E2E감사로그-${randomUUID().slice(0, 8)}`;
    await page.goto("/admin/courses");
    await page.getByPlaceholder("강의명").fill(name);
    await page.getByRole("button", { name: "등록" }).click();
    await expect(page.locator("tbody tr", { hasText: name })).toBeVisible();

    await page.goto("/admin/audit-logs");
    const row = page.locator("tbody tr", { hasText: "COURSE_CREATE" }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(adminUser.email);
  });

  test("DLQ 화면에서 미해결 항목이 보이고, '처리 완료로 표시'를 누르면 목록에서 사라진다", async ({
    page,
  }) => {
    const marker = `E2E DLQ 화면 테스트용 항목 ${randomUUID()}`;
    const { error } = await admin.from("dead_letters").insert({
      source: "MOCK",
      payload: { note: "e2e 테스트용 더미 실패" },
      error_message: marker,
    });
    expect(error).toBeNull();

    await page.goto("/admin/dlq");
    const row = page.locator("li", { hasText: marker });
    await expect(row).toBeVisible();

    await row.getByPlaceholder("처리 사유").fill("e2e 처리 확인");
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      row.getByRole("button", { name: "처리 완료로 표시" }).click(),
    ]);
    await page.reload();
    await expect(page.getByText(marker)).toHaveCount(0);
  });

  // S-2(2026-10-08): 「재시도」는 죽은(dead_at) 아웃박스 메시지 행에만 — 자동 재시도 중인 행은 폼 대신 안내 한 줄.
  // 관리자 세션이 outbox_messages를 실제로 읽는지(관리자 조회 정책)까지 브라우저로 확인한다.
  test("DLQ OUTBOX 행: 죽은 메시지에만 '재시도'가 보이고, 재시도 중인 메시지는 안내만 보인다", async ({ page }) => {
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 드레인이 집지 않게
    const fakePayload = () => ({ order_id: randomUUID(), user_id: randomUUID(), payment_event_id: randomUUID(), grants: [] });
    const { data: messages, error: msgError } = await admin
      .from("outbox_messages")
      .insert([
        { topic: "ORDER_PAID", payload: fakePayload(), attempts: 3, next_attempt_at: farFuture },
        { topic: "ORDER_PAID", payload: fakePayload(), attempts: 10, next_attempt_at: farFuture, dead_at: new Date().toISOString() },
      ])
      .select("id, attempts");
    expect(msgError).toBeNull();
    const retrying = messages!.find((m) => m.attempts === 3)!;
    const dead = messages!.find((m) => m.attempts === 10)!;

    const retryingMarker = `E2E S-2 재시도중 ${randomUUID()}`;
    const deadMarker = `E2E S-2 죽은메시지 ${randomUUID()}`;
    const { data: failures, error: dlqError } = await admin
      .from("dead_letters")
      .insert([
        { source: "OUTBOX", payload: { outbox_message_id: retrying.id }, error_message: retryingMarker },
        { source: "OUTBOX", payload: { outbox_message_id: dead.id }, error_message: deadMarker },
      ])
      .select("id");
    expect(dlqError).toBeNull();

    try {
      await page.goto("/admin/dlq");
      const retryingRow = page.locator("li", { hasText: retryingMarker });
      await expect(retryingRow).toBeVisible();
      await expect(retryingRow).toContainText("자동 재시도 중(3회 시도)");
      await expect(retryingRow.getByRole("button", { name: "재시도", exact: true })).toHaveCount(0);

      const deadRow = page.locator("li", { hasText: deadMarker });
      await expect(deadRow).toBeVisible();
      await expect(deadRow.getByRole("button", { name: "재시도", exact: true })).toHaveCount(1);
      await expect(deadRow).not.toContainText("자동 재시도 중");
    } finally {
      await admin
        .from("dead_letters")
        .update({ resolved: true, resolved_at: new Date().toISOString(), resolution_reason: "e2e 정리" })
        .in("id", (failures ?? []).map((f) => f.id));
      await admin.from("outbox_messages").delete().in("id", [retrying.id, dead.id]);
    }
  });
});

test.describe("관리자 — 무결성 점검 계층 (방치된 PENDING 신청 자동 탐지)", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let student: Awaited<ReturnType<typeof createTestUser>>;
  let courseId: string;
  let offeringId: string;
  let enrollmentId: string;

  test.beforeEach(async ({ page }) => {
    adminUser = await createTestUser({ role: "ADMIN" });
    student = await createTestUser({ role: "STUDENT" });
    ({ courseId, offeringId } = await createCourseOffering());
    enrollmentId = await createPendingOrder(student.id, offeringId, 50000);
    // "일정 기간 이상 대기상태이거나 pending상태인 이벤트를 검사"—
    // 이 신청을 8일 전에 신청된 것처럼 백데이트해 기준(7일)을 넘기게 만든다.
    await admin
      .from("orders")
      .update({ created_at: new Date(Date.now() - 8 * 86_400_000).toISOString() })
      .eq("id", enrollmentId);

    await loginAs(page, adminUser.email, adminUser.password);
  });

  test.afterEach(async () => {
    // 신청은 지우지 않고 반려로 닫는다 — 8일 전 PENDING으로 남기면 다음 드레인마다 방치 경고가 생긴다.
    await closeTestOrder(enrollmentId, adminUser.id);
    await retireTestUser(adminUser);
    await retireTestUser(student);
    await deleteCourseOffering(offeringId, courseId);
  });

  test("아웃박스 수동 실행(관리자 버튼)이 돌 때 방치된 PENDING 신청이 DLQ에 경고로 뜨고, 중복 적재되지 않는다", async ({
    page,
  }) => {
    // 1) 단계부터 대시보드 렌더은 러너를 돌리지 않는다(AP5) — "아웃박스 지금 처리"
    // 버튼(manualDrainOutbox)을 명시적으로 눌러야 배치가 돈다.
    await page.goto("/admin");
    await page.getByRole("button", { name: "아웃박스 지금 처리" }).click();
    // 버튼은 처리 중 disabled(펜딩 라벨 "처리 중...")였다가 완료되면 다시 원래 라벨로 돌아온다 —
    // 그 시점을 기다리면 배치가 끝났다는 뜻이다.
    await expect(page.getByRole("button", { name: "아웃박스 지금 처리" })).toBeEnabled();

    await page.goto("/admin/dlq");
    await expect(page.getByText(new RegExp(`PENDING 상태로 \\d+일째 방치된 신청`)).first()).toBeVisible();

    const { count: firstCount } = await admin
      .from("dead_letters")
      .select("id", { count: "exact", head: true })
      .eq("source", "INTEGRITY")
      .contains("payload", { order_id: enrollmentId });
    expect(firstCount).toBe(1);

    // 2) 버튼을 한 번 더 눌러도(같은 문제가 아직 안 풀렸으므로) 중복으로 쌓이지 않는다.
    await page.goto("/admin");
    await page.getByRole("button", { name: "아웃박스 지금 처리" }).click();
    await expect(page.getByRole("button", { name: "아웃박스 지금 처리" })).toBeEnabled();

    const { count: secondCount } = await admin
      .from("dead_letters")
      .select("id", { count: "exact", head: true })
      .eq("source", "INTEGRITY")
      .contains("payload", { order_id: enrollmentId });
    expect(secondCount).toBe(1);

    await admin.from("dead_letters").delete().contains("payload", { order_id: enrollmentId });
  });
});

test.describe("관리자 — 카탈로그 소프트 삭제의 참조 무결성", () => {
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;

  test.beforeEach(async ({ page }) => {
    adminUser = await createTestUser({ role: "ADMIN" });
    await loginAs(page, adminUser.email, adminUser.password);
  });

  test.afterEach(async () => {
    await retireTestUser(adminUser);
  });

  test("활성 개설강의가 있는 강의(과목)는 삭제(숨김)가 거부된다", async ({ page }) => {
    const courseName = `E2E과목삭제차단-${randomUUID().slice(0, 8)}`;
    const { data: course } = await admin
      .from("courses")
      .insert({ name: courseName, category: "IT" })
      .select("id")
      .single();
    const { data: offering } = await admin
      .from("course_offerings")
      .insert({
        course_id: course!.id,
        label: "차단검증기",
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

    await page.goto("/admin/courses");
    const row = page.locator("tbody tr", { hasText: courseName });
    await row.getByPlaceholder("삭제 사유").fill("E2E 삭제 시도");
    await row.getByRole("button", { name: "삭제" }).click().catch(() => {});
    await page.waitForTimeout(1000);
    await page.reload();
    // 개설강의가 살아있는 한 강의(과목)는 계속 목록에 남아 있어야 한다(삭제 거부).
    await expect(page.locator("tbody tr", { hasText: courseName })).toBeVisible();

    const { data: courseRow } = await admin
      .from("courses")
      .select("deleted_at")
      .eq("id", course!.id)
      .single();
    expect(courseRow?.deleted_at).toBeNull();

    await admin.from("course_offerings").delete().eq("id", offering!.id);
    await admin.from("courses").delete().eq("id", course!.id);
  });

  test("개설강의를 삭제(숨김)하면 날짜별 회차가 비활성으로 남고(삭제 없음) 같은 시간대를 다른 개설강의가 다시 쓸 수 있다", async ({
    page,
  }) => {
    const courseName = `E2E시간대재사용-${randomUUID().slice(0, 8)}`;
    const { data: course } = await admin
      .from("courses")
      .insert({ name: courseName, category: "IT" })
      .select("id")
      .single();

    await page.goto("/admin/course-offerings");
    await page.locator('select[name="course_id"]').selectOption({ label: courseName });
    await page.locator('input[name="label"]').fill("1기");
    await page.locator('input[name="capacity"]').fill("5");
    await page.locator('input[name="price"]').fill("10000");
    await page.locator('input[name="recruit_opens_at"]').fill(kstLocalInput(-1));
    await fillSessionPicker(page, { from: kstDateInput(30), until: kstDateInput(90), days: [1], start: "19:00", end: "21:00" }); // 월
    await page.getByRole("button", { name: "등록" }).click();
    const firstRow = page.locator("tbody tr", { hasText: courseName });
    await expect(firstRow).toBeVisible();

    const { data: firstOffering } = await admin
      .from("course_offerings")
      .select("id")
      .eq("course_id", course!.id)
      .eq("label", "1기")
      .single();
    const { count: sessionsBeforeDelete } = await admin
      .from("course_sessions")
      .select("id", { count: "exact", head: true })
      .eq("course_offering_id", firstOffering!.id);
    expect(sessionsBeforeDelete).toBeGreaterThan(1); // 기간 안의 월요일마다 날짜 행 1개

    // 신청 내역이 없으니 삭제(숨김)가 성공해야 하고, 그 회차(course_sessions)는 지워지지 않고 비활성 표시된다.
    await firstRow.getByPlaceholder("삭제 사유").fill("E2E 시간대 재사용");
    await firstRow.getByRole("button", { name: "삭제" }).click();
    await expect(page.locator("tbody tr", { hasText: courseName })).toHaveCount(0);

    const { count: activeSessionsAfterDelete } = await admin
      .from("course_sessions")
      .select("id", { count: "exact", head: true })
      .eq("course_offering_id", firstOffering!.id)
      .is("deactivated_at", null);
    expect(activeSessionsAfterDelete).toBe(0);

    const { data: keptSessions } = await admin
      .from("course_sessions")
      .select("deactivated_reason")
      .eq("course_offering_id", firstOffering!.id);
    expect(keptSessions?.length).toBe(sessionsBeforeDelete);
    expect(keptSessions?.every((s) => s.deactivated_reason === "E2E 시간대 재사용")).toBe(true);

    // 같은 요일·시간대·기간으로 두 번째 개설강의를 등록해도 EXCLUDE 제약에 안 걸려야 한다 — 겹침 검사는 살아 있는(비활성이 아닌) 회차끼리만 한다(부분 EXCLUDE).
    await page.goto("/admin/course-offerings");
    await page.locator('select[name="course_id"]').selectOption({ label: courseName });
    await page.locator('input[name="label"]').fill("2기");
    await page.locator('input[name="capacity"]').fill("5");
    await page.locator('input[name="price"]').fill("10000");
    await page.locator('input[name="recruit_opens_at"]').fill(kstLocalInput(-1));
    await fillSessionPicker(page, { from: kstDateInput(30), until: kstDateInput(90), days: [1], start: "19:00", end: "21:00" });
    await page.getByRole("button", { name: "등록" }).click();
    await expect(page.locator("tbody tr", { hasText: "2기" })).toBeVisible();

    const { data: secondOffering } = await admin
      .from("course_offerings")
      .select("id")
      .eq("course_id", course!.id)
      .eq("label", "2기")
      .single();

    await admin.from("course_sessions").delete().in("course_offering_id", [secondOffering!.id, firstOffering!.id]);
    await admin.from("course_offering_events").delete().in("course_offering_id", [secondOffering!.id, firstOffering!.id]);
    await admin.from("course_offerings").delete().eq("id", secondOffering!.id);
    await admin.from("course_offerings").delete().eq("id", firstOffering!.id);
    await admin.from("courses").delete().eq("id", course!.id);
  });
});
