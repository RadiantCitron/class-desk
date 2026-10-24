import { describe, expect, it } from "vitest";
import { formatSession, formatSessions } from "./schedule-label";

const s = (session_date: string, start_time = "19:00:00", end_time = "21:00:00", deactivated_at: string | null = null) => ({
  session_date,
  start_time,
  end_time,
  deactivated_at,
});

describe("schedule-label", () => {
  it("한 회차: 월/일(요일) 시각, 초는 자른다", () => {
    expect(formatSession(s("2026-11-03"))).toBe("11/3(화) 19:00~21:00");
    expect(formatSession(s("2026-12-25", "09:05:00", "10:00:00"))).toBe("12/25(금) 09:05~10:00");
  });

  it("회차 없음·전부 비활성이면 빈 문자열", () => {
    expect(formatSessions([])).toBe("");
    expect(formatSessions([s("2026-11-03", "19:00", "21:00", "2026-10-01T00:00:00Z")])).toBe("");
  });

  it("여러 회차(시각 같음): 총 N회 · 첫~끝 · 시각, 입력 순서 무관, 비활성 제외", () => {
    expect(
      formatSessions([s("2026-11-17"), s("2026-11-03"), s("2026-11-10"), s("2026-11-24", "19:00", "21:00", "2026-10-02T00:00:00Z")]),
    ).toBe("총 3회 · 11/3(화)~11/17(화) · 19:00~21:00");
  });

  it("여러 회차(시각 다름): 시각은 회차마다 다름", () => {
    expect(formatSessions([s("2026-11-03"), s("2026-11-10", "10:00", "12:00")])).toBe("총 2회 · 11/3(화)~11/10(화) · 시각은 회차마다 다름");
  });

  it("활성 회차 1개면 단건 표기", () => {
    expect(formatSessions([s("2026-11-03"), s("2026-11-10", "19:00", "21:00", "2026-10-02T00:00:00Z")])).toBe("11/3(화) 19:00~21:00");
  });
});
