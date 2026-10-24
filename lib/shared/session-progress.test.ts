import { describe, expect, it } from "vitest";
import { formatProgress, summarizeSessions, todayKst } from "./session-progress";

const s = (session_date: string, deactivated_at: string | null = null) => ({ session_date, deactivated_at });
const four = [s("2033-03-03"), s("2033-03-10"), s("2033-03-17"), s("2033-03-24")];

describe("summarizeSessions", () => {
  it("오늘이 둘째 회차 당일: 지난 2(당일 포함)·다음 = 셋째", () => {
    expect(summarizeSessions(four, "2033-03-10")).toEqual({ total: 4, past: 2, first: "2033-03-03", last: "2033-03-24", next: "2033-03-17" });
  });

  it("개강 전: 지난 0, 다음 = 첫 회차", () => {
    expect(summarizeSessions(four, "2033-03-02")).toMatchObject({ total: 4, past: 0, next: "2033-03-03" });
  });

  it("첫 회차 당일은 이미 지난 회차로 센다(수업받은 것으로 보는 기준)", () => {
    expect(summarizeSessions(four, "2033-03-03")).toMatchObject({ past: 1, next: "2033-03-10" });
  });

  it("마지막 회차 당일·다음 날: 지난 = 총, 다음 null", () => {
    expect(summarizeSessions(four, "2033-03-24")).toMatchObject({ past: 4, next: null });
    expect(summarizeSessions(four, "2033-03-25")).toMatchObject({ past: 4, next: null });
  });

  it("취소(비활성) 회차는 총·지난·다음·첫/끝 모두에서 제외, 입력 순서 무관", () => {
    const mixed = [s("2033-03-24"), s("2033-03-03", "2033-01-01T00:00:00Z"), s("2033-03-17"), s("2033-03-10")];
    expect(summarizeSessions(mixed, "2033-03-10")).toEqual({ total: 3, past: 1, first: "2033-03-10", last: "2033-03-24", next: "2033-03-17" });
  });

  it("활성 회차가 없으면 0과 null", () => {
    expect(summarizeSessions([], "2033-03-10")).toEqual({ total: 0, past: 0, first: null, last: null, next: null });
    expect(summarizeSessions([s("2033-03-03", "2033-01-01T00:00:00Z")], "2033-03-10")).toMatchObject({ total: 0, first: null });
  });
});

describe("todayKst", () => {
  it("한국 날짜 경계: UTC 14:59는 같은 날, 15:00부터 다음 날", () => {
    expect(todayKst(new Date("2033-03-10T14:59:59Z"))).toBe("2033-03-10");
    expect(todayKst(new Date("2033-03-10T15:00:00Z"))).toBe("2033-03-11");
    expect(todayKst(new Date("2033-12-31T15:00:00Z"))).toBe("2034-01-01");
  });
});

describe("formatProgress", () => {
  it("총·지난·다음 표시", () => {
    expect(formatProgress(summarizeSessions(four, "2033-03-10"))).toBe("총 4회 · 지난 2회 · 다음 3/17(목)");
  });
  it("다음이 없으면 생략, 회차 없으면 빈 문자열", () => {
    expect(formatProgress(summarizeSessions(four, "2033-03-25"))).toBe("총 4회 · 지난 4회");
    expect(formatProgress(summarizeSessions([], "2033-03-25"))).toBe("");
  });
});
