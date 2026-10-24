import { describe, expect, it } from "vitest";
import { offeringLifecycle, offeringLifecycleLabel } from "./offering-lifecycle";

const NOW = new Date("2026-10-08T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

const base = { status: "OPEN", recruit_opens_at: day(-10), opens_at: day(5), ends_at: day(30), ended_at: null as string | null };

describe("개설강의 수명 표시", () => {
  it("모집 시작 전 → 모집 전, 모집 기간 → 모집중", () => {
    expect(offeringLifecycle({ ...base, recruit_opens_at: day(1) }, NOW)).toBe("BEFORE_RECRUIT");
    expect(offeringLifecycle(base, NOW)).toBe("RECRUITING");
  });

  it("개강 전 마감 → 마감, 개강 뒤에는 마감이어도 강의 중", () => {
    expect(offeringLifecycle({ ...base, status: "CLOSED" }, NOW)).toBe("CLOSED");
    expect(offeringLifecycle({ ...base, status: "CLOSED", opens_at: day(-2) }, NOW)).toBe("IN_PROGRESS");
  });

  it("개강 지남 + 종강 전 → 강의 중", () => {
    expect(offeringLifecycle({ ...base, opens_at: day(-2) }, NOW)).toBe("IN_PROGRESS");
  });

  it("종강일 지남 + 종료 기록 없음 → 종료 처리 대기, 종료 기록 있으면 종료", () => {
    const past = { ...base, opens_at: day(-30), ends_at: day(-1) };
    expect(offeringLifecycle(past, NOW)).toBe("END_PENDING");
    expect(offeringLifecycle({ ...past, ended_at: day(-1) }, NOW)).toBe("ENDED");
  });

  it("종강일이 없는 강의는 개강 뒤 계속 강의 중(수동 종료만)", () => {
    expect(offeringLifecycle({ ...base, opens_at: day(-100), ends_at: null }, NOW)).toBe("IN_PROGRESS");
    expect(offeringLifecycle({ ...base, opens_at: day(-100), ends_at: null, ended_at: day(-1) }, NOW)).toBe("ENDED");
  });

  it("폐강(취소)은 종료보다 우선하고 종료와 다른 상태다", () => {
    const ended = { ...base, opens_at: day(-30), ends_at: day(-1), ended_at: day(-1) };
    expect(offeringLifecycle({ ...ended, status: "CANCELLING" }, NOW)).toBe("CANCELLING");
    expect(offeringLifecycle({ ...ended, status: "CANCELLED" }, NOW)).toBe("CANCELLED");
    expect(offeringLifecycleLabel({ ...base, status: "CANCELLING" }, NOW)).toBe("폐강중");
    expect(offeringLifecycleLabel({ ...base, status: "CANCELLED" }, NOW)).toBe("폐강완료");
  });

  it("라벨", () => {
    expect(offeringLifecycleLabel(base, NOW)).toBe("모집중");
    expect(offeringLifecycleLabel({ ...base, opens_at: day(-2) }, NOW)).toBe("강의 중");
    expect(offeringLifecycleLabel({ ...base, opens_at: day(-30), ends_at: day(-1) }, NOW)).toBe("종료 처리 대기");
    expect(offeringLifecycleLabel({ ...base, opens_at: day(-30), ends_at: day(-1), ended_at: day(-1) }, NOW)).toBe("종료");
  });
});
