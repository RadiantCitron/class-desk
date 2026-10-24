import { describe, it, expect } from "vitest";
import { formatSession, formatSessions } from "./schedule-label";
import { formatKst, parseKstLocal, toKstLocalInput } from "./datetime";

describe("lib/shared 표시 헬퍼", () => {
  it("회차 문구는 월/일(요일)과 HH:MM~HH:MM이다(자세한 경우는 schedule-label.test.ts)", () => {
    expect(formatSession({ session_date: "2026-11-03", start_time: "19:00:00", end_time: "21:00:00" })).toBe(
      "11/3(화) 19:00~21:00",
    );
    expect(
      formatSessions([
        { session_date: "2026-11-02", start_time: "10:00", end_time: "12:00" },
        { session_date: "2026-11-04", start_time: "10:00", end_time: "12:00" },
      ]),
    ).toBe("총 2회 · 11/2(월)~11/4(수) · 10:00~12:00");
  });

  it("시각은 서버 시간대와 무관하게 한국 시간으로 표시한다", () => {
    // 2026-10-01T10:00:00Z = 한국 19:00(ko-KR 표기는 오후 7:00)
    const text = formatKst("2026-10-01T10:00:00Z");
    expect(text).toContain("오후 7:00");
    expect(text).toContain("2026. 10. 1.");
    expect(formatKst(null)).toBe("-");
  });
});

describe("datetime-local 입력 ↔ 한국 시간 변환", () => {
  it("입력은 한국 시간으로 해석한다(서버 시간대와 무관)", () => {
    expect(parseKstLocal("2026-10-01T19:00")).toBe("2026-10-01T10:00:00.000Z");
    expect(parseKstLocal("2026-10-01T19:00:30")).toBe("2026-10-01T10:00:30.000Z");
    // 날짜가 넘어가는 경우: 한국 자정 직후 = 전날 UTC 15시
    expect(parseKstLocal("2026-10-02T00:30")).toBe("2026-10-01T15:30:00.000Z");
  });

  it("입력 → ISO → 입력 왕복이 같은 값이다", () => {
    for (const value of ["2026-10-01T19:00", "2026-12-31T23:59", "2027-01-01T00:00"]) {
      expect(toKstLocalInput(parseKstLocal(value))).toBe(value);
    }
  });

  it("빈 값·잘못된 형식을 처리한다", () => {
    expect(toKstLocalInput(null)).toBe("");
    expect(toKstLocalInput("")).toBe("");
    expect(() => parseKstLocal("")).toThrow();
    expect(() => parseKstLocal("2026-10-01 19:00")).toThrow();
    expect(() => parseKstLocal("2026-13-45T25:61")).toThrow();
  });
});
