import { describe, expect, it } from "vitest";
import { dayOfWeek, isValidDate, monthGrid, shiftMonth, weekdayDates, weekdayDatesN } from "./session-calendar";

describe("session-calendar", () => {
  it("날짜 검증: 형식과 실제 달력", () => {
    expect(isValidDate("2026-11-03")).toBe(true);
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("2026-1-1")).toBe(false);
    expect(isValidDate("")).toBe(false);
  });

  it("요일: 일=0, 잘못된 날짜 -1", () => {
    expect(dayOfWeek("2026-11-01")).toBe(0);
    expect(dayOfWeek("2026-11-03")).toBe(2);
    expect(dayOfWeek("nope")).toBe(-1);
  });

  it("월 격자: 2026년 11월은 일요일 시작 1일, 30일, 마지막 주는 null로 채움", () => {
    const grid = monthGrid(2026, 11);
    expect(grid[0][0]).toBe("2026-11-01");
    expect(grid.every((w) => w.length === 7)).toBe(true);
    expect(grid.flat().filter(Boolean)).toHaveLength(30);
    expect(grid[grid.length - 1].filter(Boolean).pop()).toBe("2026-11-30");
  });

  it("월 격자: 앞 칸 채움(2026년 10월 1일은 목요일), 윤년 2월 29일", () => {
    const oct = monthGrid(2026, 10);
    expect(oct[0].slice(0, 4)).toEqual([null, null, null, null]);
    expect(oct[0][4]).toBe("2026-10-01");
    const feb = monthGrid(2028, 2).flat().filter(Boolean);
    expect(feb).toHaveLength(29);
    expect(feb[28]).toBe("2028-02-29");
    expect(monthGrid(2027, 2).flat().filter(Boolean)).toHaveLength(28);
  });

  it("월 이동: 연말·연초 넘김", () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 6, 0)).toEqual({ year: 2026, month: 6 });
    expect(shiftMonth(2026, 11, 14)).toEqual({ year: 2028, month: 1 });
  });

  it("요일 채우기: 월·수 2주, 양 끝 포함, 오름차순", () => {
    expect(weekdayDates("2026-11-02", "2026-11-15", [3, 1])).toEqual(["2026-11-02", "2026-11-04", "2026-11-09", "2026-11-11"]);
    expect(weekdayDates("2026-11-03", "2026-11-17", [2])).toEqual(["2026-11-03", "2026-11-10", "2026-11-17"]);
  });

  it("요일 채우기: 잘못된 입력·역순·해당 요일 없음·범위 밖 요일 값은 빈 배열", () => {
    expect(weekdayDates("2026-11-05", "2026-11-03", [2])).toEqual([]);
    expect(weekdayDates("bad", "2026-11-03", [2])).toEqual([]);
    expect(weekdayDates("2026-11-03", "2026-11-04", [0])).toEqual([]);
    expect(weekdayDates("2026-11-03", "2026-11-10", [9, -1])).toEqual([]);
    expect(weekdayDates("2026-11-03", "2026-11-10", [])).toEqual([]);
    expect(weekdayDates("2000-01-01", "2030-01-01", [1])).toEqual([]);
  });

  it("N회 채우기: 시작일부터 고른 요일로 정확히 N개 채움 (월수금 3회, 5일 연속 등)", () => {
    // 2026-11-02는 월요일(1) -> 월·수·금([1, 3, 5]) 3회
    expect(weekdayDatesN("2026-11-02", 3, [1, 3, 5])).toEqual(["2026-11-02", "2026-11-04", "2026-11-06"]);
    // 월~금 5일 연속
    expect(weekdayDatesN("2026-11-02", 5, [1, 2, 3, 4, 5])).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
    ]);
    // N=1 경계
    expect(weekdayDatesN("2026-11-02", 1, [1, 3])).toEqual(["2026-11-02"]);
  });

  it("N회 채우기: until(종료일)과 함께 주어지면 둘 중 먼저 닿는 곳에서 멈춤", () => {
    // 3회 요청했으나 until이 11-05라 월(02), 수(04)만 걸려서 2개에서 멈춤
    expect(weekdayDatesN("2026-11-02", 3, [1, 3, 5], "2026-11-05")).toEqual(["2026-11-02", "2026-11-04"]);
    // 2회 요청이고 until은 11-10까지 넉넉하면 N회(2회)에서 먼저 멈춤
    expect(weekdayDatesN("2026-11-02", 2, [1, 3, 5], "2026-11-10")).toEqual(["2026-11-02", "2026-11-04"]);
  });

  it("N회 채우기: 잘못된 입력(유효하지 않은 날짜, N <= 0, 요일 없음)은 빈 배열", () => {
    expect(weekdayDatesN("invalid", 3, [1])).toEqual([]);
    expect(weekdayDatesN("2026-11-02", 0, [1])).toEqual([]);
    expect(weekdayDatesN("2026-11-02", -5, [1])).toEqual([]);
    expect(weekdayDatesN("2026-11-02", 3, [])).toEqual([]);
    expect(weekdayDatesN("2026-11-02", 3, [9, -1])).toEqual([]);
  });
});

