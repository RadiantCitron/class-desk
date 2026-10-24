import { describe, it, expect } from "vitest";
import {
  formatOfferingEventTitle,
  formatOfferingEventDetail,
  type OfferingEventRow,
} from "./offering-event";

describe("개설강의 사건 원장 포맷터 (offering-event)", () => {
  it("CREATED: 개설 이벤트 제목과 상세 포맷", () => {
    const row: OfferingEventRow = {
      id: "evt-1",
      course_offering_id: "off-1",
      event_type: "CREATED",
      actor: "ADMIN",
      actor_user_id: "admin-1",
      reason: null,
      before: null,
      after: {
        label: "2026 가을반",
        capacity: 10,
        price: 50000,
        sessions: [
          { date: "2026-11-01", start: "10:00", end: "12:00" },
          { date: "2026-11-08", start: "10:00", end: "12:00" },
        ],
      },
      created_at: "2026-10-10T09:00:00Z",
    };
    expect(formatOfferingEventTitle(row)).toBe("개설");
    expect(formatOfferingEventDetail(row)).toContain("정원 10명");
    expect(formatOfferingEventDetail(row)).toContain("50,000원");
    expect(formatOfferingEventDetail(row)).toContain("회차 2개");
  });

  it("UPDATED: 가격 및 정원 수정 포맷", () => {
    const row: OfferingEventRow = {
      id: "evt-2",
      course_offering_id: "off-1",
      event_type: "UPDATED",
      actor: "ADMIN",
      actor_user_id: "admin-1",
      reason: "가격 인하",
      before: { price: 50000 },
      after: { price: 45000 },
      created_at: "2026-10-10T09:00:00Z",
    };
    expect(formatOfferingEventTitle(row)).toBe("수정");
    expect(formatOfferingEventDetail(row)).toContain("가격 50,000원 → 45,000원");
  });

  it("STATUS_CHANGED: 상태 변경 포맷", () => {
    const row: OfferingEventRow = {
      id: "evt-3",
      course_offering_id: "off-1",
      event_type: "STATUS_CHANGED",
      actor: "ADMIN",
      actor_user_id: "admin-1",
      reason: "마감",
      before: { status: "OPEN" },
      after: { status: "CLOSED" },
      created_at: "2026-10-10T09:00:00Z",
    };
    expect(formatOfferingEventTitle(row)).toBe("상태 변경");
    expect(formatOfferingEventDetail(row)).toContain("OPEN → CLOSED");
  });

  it("SESSION_ADDED / SESSION_CANCELLED: 회차 추가 및 취소 포맷", () => {
    const addRow: OfferingEventRow = {
      id: "evt-4",
      course_offering_id: "off-1",
      event_type: "SESSION_ADDED",
      actor: "ADMIN",
      actor_user_id: "admin-1",
      reason: "보강",
      before: null,
      after: { session_date: "2026-11-15", start_time: "10:00", end_time: "12:00" },
      created_at: "2026-10-10T09:00:00Z",
    };
    expect(formatOfferingEventTitle(addRow)).toBe("회차 추가");
    expect(formatOfferingEventDetail(addRow)).toContain("2026-11-15 10:00~12:00");

    const cancelRow: OfferingEventRow = {
      id: "evt-5",
      course_offering_id: "off-1",
      event_type: "SESSION_CANCELLED",
      actor: "ADMIN",
      actor_user_id: "admin-1",
      reason: "휴강",
      before: { session_date: "2026-11-15", start_time: "10:00", end_time: "12:00" },
      after: { deactivated_reason: "휴강" },
      created_at: "2026-10-10T09:00:00Z",
    };
    expect(formatOfferingEventTitle(cancelRow)).toBe("회차 취소");
    expect(formatOfferingEventDetail(cancelRow)).toContain("2026-11-15 10:00~12:00");
  });

  it("SCHEDULE_CHANGED: 일정 변경 포맷", () => {
    const row: OfferingEventRow = {
      id: "evt-6",
      course_offering_id: "off-1",
      event_type: "SCHEDULE_CHANGED",
      actor: "ADMIN",
      actor_user_id: "admin-1",
      reason: "시간 변경",
      before: [{ date: "2026-11-01", start: "10:00", end: "12:00" }],
      after: {
        active_sessions: [{ date: "2026-11-01", start: "14:00", end: "16:00" }],
        cancelled_session_ids: ["s1"],
        added_session_ids: ["s2"],
        notified_orders: 3,
      },
      created_at: "2026-10-10T09:00:00Z",
    };
    expect(formatOfferingEventTitle(row)).toBe("일정 변경");
    expect(formatOfferingEventDetail(row)).toContain("취소 1개 · 추가 1개");
    expect(formatOfferingEventDetail(row)).toContain("수강생 3명 안내");
  });

  it("CANCEL_STARTED / CANCEL_COMPLETED: 폐강 시작 및 완료", () => {
    const rowStart: OfferingEventRow = {
      id: "evt-7",
      course_offering_id: "off-1",
      event_type: "CANCEL_STARTED",
      actor: "ADMIN",
      actor_user_id: "admin-1",
      reason: "폐강",
      before: { status: "OPEN" },
      after: { status: "CANCELLING", action_required: 2 },
      created_at: "2026-10-10T09:00:00Z",
    };
    expect(formatOfferingEventTitle(rowStart)).toBe("폐강 시작");
    expect(formatOfferingEventDetail(rowStart)).toContain("처리 대상 2명");

    const rowEnd: OfferingEventRow = {
      id: "evt-8",
      course_offering_id: "off-1",
      event_type: "CANCEL_COMPLETED",
      actor: "ADMIN",
      actor_user_id: "admin-1",
      reason: "폐강 처리 완료",
      before: { status: "CANCELLING" },
      after: { status: "CANCELLED" },
      created_at: "2026-10-10T09:00:00Z",
    };
    expect(formatOfferingEventTitle(rowEnd)).toBe("폐강 완료");
  });

  it("ENDED / END_CANCELLED: 종료 및 종료 취소", () => {
    const rowEnd: OfferingEventRow = {
      id: "evt-9",
      course_offering_id: "off-1",
      event_type: "ENDED",
      actor: "SYSTEM",
      actor_user_id: null,
      reason: "자동 종료",
      before: null,
      after: { end_note: "자동 종료", approved_orders: 5 },
      created_at: "2026-10-10T09:00:00Z",
    };
    expect(formatOfferingEventTitle(rowEnd)).toBe("강의 종료");
    expect(formatOfferingEventDetail(rowEnd)).toContain("수강생 5명 권한 회수");

    const rowReopen: OfferingEventRow = {
      id: "evt-10",
      course_offering_id: "off-1",
      event_type: "END_CANCELLED",
      actor: "ADMIN",
      actor_user_id: "admin-1",
      reason: "종강일 오류",
      before: { end_note: "자동 종료" },
      after: { regranted_orders: 5 },
      created_at: "2026-10-10T09:00:00Z",
    };
    expect(formatOfferingEventTitle(rowReopen)).toBe("종료 취소");
    expect(formatOfferingEventDetail(rowReopen)).toContain("수강생 5명 권한 재부여");
  });
});
