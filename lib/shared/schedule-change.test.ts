import { describe, expect, it } from "vitest";
import {
  canExcludeForScheduleChange,
  describeChangedLines,
  describeLines,
  diffSessions,
  isImminentScheduleChange,
  noticeAgeDays,
  scheduleChangeState,
} from "./schedule-change";
import type { OrderEventLike } from "./refund-request";

const ev = (id: string, event_type: string, created_at: string, payload: Record<string, unknown> | null = {}): OrderEventLike => ({ id, event_type, created_at, payload });
const notice = (id: string, at: string, extra: Record<string, unknown> = {}) =>
  ev(id, "SCHEDULE_CHANGE_NOTICE", at, {
    change_id: `c-${id}`, reason: "강사 사정", before: [{ date: "2033-07-05", start: "19:00:00", end: "21:00:00" }], after: [{ date: "2033-07-12", start: "19:00", end: "21:00" }], ...extra,
  });
const accept = (id: string, noticeId: string, at: string) => ev(id, "SCHEDULE_CHANGE_ACCEPTED", at, { notice_event_id: noticeId });
const decline = (id: string, noticeId: string, at: string) => ev(id, "SCHEDULE_CHANGE_DECLINED", at, { notice_event_id: noticeId });

describe("scheduleChangeState", () => {
  it("안내가 없거나 주문이 종료됐으면 null", () => {
    expect(scheduleChangeState([], "APPROVED")).toBeNull();
    expect(scheduleChangeState([notice("n1", "2033-06-01T00:00:00Z")], "CANCELLED")).toBeNull();
  });
  it("환불 신청이 없으면 안내됨(NOTIFIED), 안내 내용(사유·전후 일정)을 담는다", () => {
    const s = scheduleChangeState([notice("n1", "2033-06-01T00:00:00Z")], "APPROVED");
    expect(s).toMatchObject({ noticeId: "n1", changeId: "c-n1", status: "NOTIFIED", reason: "강사 사정" });
    expect(s?.before).toEqual([{ date: "2033-07-05", start: "19:00", end: "21:00" }]);
    expect(s?.after).toEqual([{ date: "2033-07-12", start: "19:00", end: "21:00" }]);
  });
  it("과거 동의/미동의 응답 호환(LEGACY_ACCEPTED / LEGACY_DECLINED)", () => {
    expect(scheduleChangeState([notice("n1", "2033-06-01T00:00:00Z"), accept("a1", "n1", "2033-06-02T00:00:00Z")], "APPROVED")?.status).toBe("LEGACY_ACCEPTED");
    expect(scheduleChangeState([notice("n1", "2033-06-01T00:00:00Z"), decline("d1", "n1", "2033-06-02T00:00:00Z")], "PENDING")?.status).toBe("LEGACY_DECLINED");
  });
  it("안내에 대한 환불 신청이 있으면 REFUND_REQUESTED", () => {
    const refundEvent = ev("r1", "REFUND_REQUESTED", "2033-06-02T00:00:00Z", {
      proposal: { context: { schedule_change_notice_event_id: "n1" } },
    });
    expect(scheduleChangeState([notice("n1", "2033-06-01T00:00:00Z"), refundEvent], "APPROVED")?.status).toBe("REFUND_REQUESTED");
  });
  it("또 일정이 바뀌면 새 안내가 최신 상태가 된다", () => {
    const events = [notice("n1", "2033-06-01T00:00:00Z"), accept("a1", "n1", "2033-06-02T00:00:00Z"), notice("n2", "2033-06-05T00:00:00Z")];
    const s = scheduleChangeState(events, "APPROVED");
    expect(s?.noticeId).toBe("n2");
    expect(s?.status).toBe("NOTIFIED");
  });
  it("다른 안내를 가리키는 응답은 무시한다 / 입력 순서와 무관", () => {
    const events = [accept("a0", "old", "2033-06-03T00:00:00Z"), notice("n1", "2033-06-01T00:00:00Z")];
    expect(scheduleChangeState(events, "APPROVED")?.status).toBe("NOTIFIED");
    expect(scheduleChangeState([...events].reverse(), "APPROVED")?.status).toBe("NOTIFIED");
  });
  it("payload가 비었거나 모양이 틀려도 죽지 않는다", () => {
    const s = scheduleChangeState([ev("n1", "SCHEDULE_CHANGE_NOTICE", "2033-06-01T00:00:00Z", null)], "APPROVED");
    expect(s).toMatchObject({ changeId: null, reason: "", before: [], after: [] });
  });
});

describe("제외 처리 가능 여부", () => {
  it("안내가 있으면 제외 처리 가능, 안내 없으면 불가", () => {
    const base = notice("n1", "2033-06-01T00:00:00Z");
    expect(canExcludeForScheduleChange(scheduleChangeState([base], "APPROVED"))).toBe(true);
    expect(canExcludeForScheduleChange(null)).toBe(false);
  });
});

describe("diffSessions", () => {
  const cur = [
    { id: "s1", date: "2033-07-05", start: "19:00:00", end: "21:00:00" },
    { id: "s2", date: "2033-07-12", start: "19:00:00", end: "21:00:00" },
  ];
  it("같으면 변경 없음(초 단위 표기 차이는 무시)", () => {
    expect(diffSessions(cur, [{ date: "2033-07-05", start: "19:00", end: "21:00" }, { date: "2033-07-12", start: "19:00", end: "21:00" }])).toEqual({ cancelIds: [], add: [] });
  });
  it("날짜 하나를 다른 날로 옮기면 취소 1 + 추가 1", () => {
    expect(diffSessions(cur, [{ date: "2033-07-05", start: "19:00", end: "21:00" }, { date: "2033-07-19", start: "19:00", end: "21:00" }])).toEqual({
      cancelIds: ["s2"], add: [{ date: "2033-07-19", start: "19:00", end: "21:00" }],
    });
  });
  it("같은 날짜의 시각만 바꾸면 취소 + 추가", () => {
    const d = diffSessions(cur, [{ date: "2033-07-05", start: "20:00", end: "22:00" }, { date: "2033-07-12", start: "19:00", end: "21:00" }]);
    expect(d.cancelIds).toEqual(["s1"]);
    expect(d.add).toEqual([{ date: "2033-07-05", start: "20:00", end: "22:00" }]);
  });
  it("회차를 더하기만 / 빼기만", () => {
    expect(diffSessions(cur, [...[{ date: "2033-07-05", start: "19:00", end: "21:00" }, { date: "2033-07-12", start: "19:00", end: "21:00" }], { date: "2033-07-20", start: "10:00", end: "11:00" }])).toEqual({
      cancelIds: [], add: [{ date: "2033-07-20", start: "10:00", end: "11:00" }],
    });
    expect(diffSessions(cur, [{ date: "2033-07-05", start: "19:00", end: "21:00" }])).toEqual({ cancelIds: ["s2"], add: [] });
  });
});

describe("문구·경과일", () => {
  it("일정 한 줄 요약(날짜순, 요일 표기)", () => {
    expect(describeLines([{ date: "2033-07-12", start: "19:00", end: "21:00" }, { date: "2033-07-05", start: "10:00:00", end: "12:00:00" }])).toBe("7/5(화) 10:00~12:00, 7/12(화) 19:00~21:00");
    expect(describeLines([])).toBe("(없음)");
  });
  it("안내 경과일", () => {
    const now = new Date("2033-06-15T12:00:00Z");
    expect(noticeAgeDays("2033-06-15T11:00:00Z", now)).toBe(0);
    expect(noticeAgeDays("2033-06-10T12:00:00Z", now)).toBe(5);
  });
  it("변경된 회차 강조 — 바뀐 회차에 (변경) 표기", () => {
    const before = [
      { date: "2033-07-05", start: "19:00", end: "21:00" },
      { date: "2033-07-12", start: "19:00", end: "21:00" },
    ];
    const after = [
      { date: "2033-07-05", start: "19:00", end: "21:00" },
      { date: "2033-07-19", start: "19:00", end: "21:00" },
    ];
    expect(describeChangedLines(before, after)).toBe("7/5(화) 19:00~21:00, 7/19(화) 19:00~21:00 (변경)");
  });
  it("시작 임박 회차 변경 판정 — 2시간 이내 취소/추가 감지", () => {
    const baseNow = new Date("2033-07-05T08:00:00+09:00");
    // 09:30 시작 회차 취소 -> 1.5시간 남음 -> 임박 (true)
    expect(isImminentScheduleChange([{ date: "2033-07-05", start: "09:30" }], [], baseNow)).toBe(true);
    // 11:00 시작 회차 취소 -> 3시간 남음 -> 임박 아님 (false)
    expect(isImminentScheduleChange([{ date: "2033-07-05", start: "11:00" }], [], baseNow)).toBe(false);
    // 이미 지난 회차(07:00) -> 미래 아님 -> 임박 아님 (false)
    expect(isImminentScheduleChange([{ date: "2033-07-05", start: "07:00" }], [], baseNow)).toBe(false);
    // 09:30 추가 회차 -> 1.5시간 후 시작 -> 임박 (true)
    expect(isImminentScheduleChange([], [{ date: "2033-07-05", start: "09:30", end: "10:30" }], baseNow)).toBe(true);
  });
});

