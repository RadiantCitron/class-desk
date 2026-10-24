import { describe, expect, it } from "vitest";
import { compareTimestamps, fetchAllPages, fetchInChunks, IN_CHUNK, PAGE_SIZE } from "./paging";

// 가짜 "테이블"(0..n-1)에서 range(from,to)를 흉내 낸다.
function fakeTable(n: number) {
  const calls: Array<[number, number]> = [];
  const fetchPage = async (from: number, to: number) => {
    calls.push([from, to]);
    const rows: number[] = [];
    for (let i = from; i <= Math.min(to, n - 1); i++) rows.push(i);
    return { data: rows, error: null };
  };
  return { fetchPage, calls };
}

describe("fetchAllPages", () => {
  it("0건이면 한 번만 조회하고 빈 배열", async () => {
    const t = fakeTable(0);
    expect(await fetchAllPages(t.fetchPage)).toEqual([]);
    expect(t.calls).toHaveLength(1);
  });

  it("정확히 한 페이지(1000건)면 다음 페이지가 비어 있는지 한 번 더 확인한다", async () => {
    const t = fakeTable(PAGE_SIZE);
    const rows = await fetchAllPages(t.fetchPage);
    expect(rows).toHaveLength(PAGE_SIZE);
    expect(t.calls).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it("2500건이면 3페이지를 이어 붙이고 중복·누락이 없다", async () => {
    const t = fakeTable(2500);
    const rows = await fetchAllPages(t.fetchPage);
    expect(rows).toHaveLength(2500);
    expect(rows[0]).toBe(0);
    expect(rows[2499]).toBe(2499);
    expect(new Set(rows).size).toBe(2500);
    expect(t.calls).toHaveLength(3);
  });

  it("조회 오류는 그대로 던진다", async () => {
    await expect(
      fetchAllPages(async () => ({ data: null, error: { message: "boom" } })),
    ).rejects.toThrow("boom");
  });
});

describe("fetchInChunks", () => {
  it("id를 100개씩 나눠 조회하고 결과를 합친다(경계: 100·101·250개)", async () => {
    for (const n of [0, 1, IN_CHUNK, IN_CHUNK + 1, 250]) {
      const ids = Array.from({ length: n }, (_, i) => `id-${i}`);
      const chunksSeen: string[][] = [];
      const rows = await fetchInChunks<string>(ids, async (chunk) => {
        chunksSeen.push(chunk);
        return { data: chunk, error: null };
      });
      expect(rows).toEqual(ids);
      expect(chunksSeen.every((c) => c.length <= IN_CHUNK)).toBe(true);
      expect(chunksSeen.length).toBe(Math.ceil(n / IN_CHUNK));
    }
  });

  it("한 조각의 결과가 1000행을 넘으면 그 조각 안에서 페이지를 이어 붙인다", async () => {
    const ids = ["a"];
    const rows = await fetchInChunks<number>(ids, async (_chunk, from, to) => {
      const out: number[] = [];
      for (let i = from; i <= Math.min(to, 1499); i++) out.push(i);
      return { data: out, error: null };
    });
    expect(rows).toHaveLength(1500);
  });
});

describe("compareTimestamps", () => {
  it("밀리초가 다르면 시각 순서대로", () => {
    expect(compareTimestamps("2026-09-30T13:00:00.100+00:00", "2026-09-30T13:00:00.200+00:00")).toBeLessThan(0);
    expect(compareTimestamps("2026-09-30T13:00:01.000+00:00", "2026-09-30T13:00:00.999+00:00")).toBeGreaterThan(0);
  });

  it("같은 밀리초면 마이크로초 문자열로 비교하고, 완전히 같으면 0", () => {
    expect(compareTimestamps("2026-09-30T13:00:00.679+00:00", "2026-09-30T13:00:00.679123+00:00")).toBeLessThan(0);
    expect(compareTimestamps("2026-09-30T13:00:00.679124+00:00", "2026-09-30T13:00:00.679123+00:00")).toBeGreaterThan(0);
    expect(compareTimestamps("2026-09-30T13:00:00.679+00:00", "2026-09-30T13:00:00.679+00:00")).toBe(0);
  });
});
