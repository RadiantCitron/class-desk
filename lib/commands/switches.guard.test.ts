import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { MODULE_LABELS } from "@/lib/architecture/module-map";
import { ALL_COMMANDS } from "./registry";

// 명령 레일 CR-2 — 통제 스위치 테이블(DB)과 등록부(TS)가 같은 목록을 보는지 고정한다.
// 목록의 주인은 TS 등록부다. DB 제약은 그 사본이라, 어느 한쪽만 바뀌면 여기서 실패한다(gates.guard.test.ts와 같은 원칙).

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

// rail_switches 제약을 마지막으로 정의한 마이그레이션 본문(지금은 20261007130000 하나).
function railSwitchesSql(): string {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf-8"))
    .filter((sql) => /rail_switches_axiom_untouchable/.test(sql));
  expect(files.length).toBeGreaterThan(0);
  return files[files.length - 1];
}

function quotedList(sql: string, afterMarker: string): string[] {
  const start = sql.indexOf(afterMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf("(", sql.indexOf(" in ", start));
  const close = sql.indexOf(")", open);
  return [...sql.slice(open, close).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
}

describe("통제 스위치 DB 제약 ↔ 등록부", () => {
  it("공리(끌 수 없는 명령) 목록이 등록부의 axiom과 같다", () => {
    const sql = railSwitchesSql();
    const dbAxioms = quotedList(sql, "constraint rail_switches_axiom_untouchable");
    const tsAxioms = ALL_COMMANDS.filter((c) => c.axiom).map((c) => c.code).sort();
    expect(dbAxioms).toEqual(tsAxioms);
  });

  it("MODULE 층이 허용하는 대상이 모듈 지도의 모듈 5개와 같다", () => {
    const sql = railSwitchesSql();
    const start = sql.indexOf("(level = 'MODULE'");
    expect(start).toBeGreaterThanOrEqual(0);
    const dbModules = quotedList(sql.slice(start), "target in");
    expect(dbModules).toEqual(Object.keys(MODULE_LABELS).sort());
  });
});
