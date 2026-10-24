import { describe, expect, it } from "vitest";
import { MAX_SESSIONS_PER_OFFERING, parseSessionRows } from "./session-rows";

const row = (date: string, start = "19:00", end = "21:00") => ({ date, start, end });
const parse = (v: unknown) => parseSessionRows(JSON.stringify(v));

describe("parseSessionRows", () => {
  it("정상: 날짜·시작 순으로 정렬해 돌려준다(회차마다 시각이 달라도 됨)", () => {
    expect(parse([row("2026-11-10", "10:00", "12:00"), row("2026-11-03"), row("2026-11-03", "08:00", "09:00")])).toEqual([
      row("2026-11-03", "08:00", "09:00"),
      row("2026-11-03"),
      row("2026-11-10", "10:00", "12:00"),
    ]);
  });

  it("JSON이 아니거나 배열이 아니면 형식 오류", () => {
    expect(() => parseSessionRows("{")).toThrow("형식이 올바르지 않습니다");
    expect(() => parse({ date: "2026-11-03" })).toThrow("형식이 올바르지 않습니다");
    expect(() => parse([null])).toThrow("형식이 올바르지 않습니다");
    expect(() => parse([{ date: "2026-11-03", start: "19:00" }])).toThrow("형식이 올바르지 않습니다");
    expect(() => parse([{ date: 20261103, start: "19:00", end: "21:00" }])).toThrow("형식이 올바르지 않습니다");
  });

  it("빈 배열은 오류, 100개는 통과, 101개는 오류", () => {
    expect(() => parse([])).toThrow("1개 이상");
    const many = (n: number) => Array.from({ length: n }, (_, i) => row(new Date(Date.UTC(2030, 0, 1 + i)).toISOString().slice(0, 10)));
    expect(parse(many(MAX_SESSIONS_PER_OFFERING))).toHaveLength(MAX_SESSIONS_PER_OFFERING);
    expect(() => parse(many(MAX_SESSIONS_PER_OFFERING + 1))).toThrow(String(MAX_SESSIONS_PER_OFFERING));
  });

  it("날짜: 형식·실제 날짜 검증", () => {
    expect(() => parse([row("2026-13-01")])).toThrow("날짜가 올바르지 않습니다");
    expect(() => parse([row("2026-02-30")])).toThrow("날짜가 올바르지 않습니다");
    expect(() => parse([row("2026-1-1")])).toThrow("날짜가 올바르지 않습니다");
  });

  it("시각: 형식과 시작 < 종료", () => {
    expect(() => parse([row("2026-11-03", "7:00", "21:00")])).toThrow("시각 형식");
    expect(() => parse([row("2026-11-03", "19:00", "24:00")])).toThrow("시각 형식");
    expect(() => parse([row("2026-11-03", "21:00", "21:00")])).toThrow("종료 시각");
    expect(() => parse([row("2026-11-03", "22:00", "21:00")])).toThrow("종료 시각");
  });
});
