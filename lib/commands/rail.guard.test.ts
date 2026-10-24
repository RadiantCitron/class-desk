import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { ALL_COMMANDS, COMMANDS_BY_MODULE, isCommandCode } from "./registry";
import { CS_SINK_TABLES, FUNCTION_OWNER, TABLE_OWNER, type ModuleName } from "@/lib/architecture/module-map";

// 명령 레일 구조 가드(ADR-0015).
// "모든 명령·조회는 레일 입구 하나를 지난다"를 사람의 기억이 아니라 테스트로 고정한다. 방식은 boundaries.guard.test.ts와 같다:
// 파일을 순회하고, 줄 주석을 뺀 뒤, 정규식으로 호출을 본다.
const root = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "supabase", "e2e", "docs", "public"]);

function collect(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(relative(root, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

function stripLineComments(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function read(file: string): string {
  return stripLineComments(readFileSync(join(root, file), "utf-8"));
}

const appFiles = collect(join(root, "app"));
const libFiles = collect(join(root, "lib"));
const uiFiles = collect(join(root, "ui"));
const viewFiles = uiFiles.filter((f) => f.startsWith("ui/views/"));

// ── 레일 밖(사실 처리) 닫힌 목록 ───────────────────────────────────────────────────────────────────────────
// 명령이 아니라 "이미 일어난 사실의 결과를 집행"하거나 상태를 보고하는 곳이다. 이 목록에 줄을 추가하는 것은 금지다.
const FACT_PROCESSING: Record<string, string> = {
  "app/api/webhooks/payment/[provider]/route.ts": "PG 웹훅 — 돈은 이미 움직였다, 막으면 결제와 장부가 어긋난다",
  "app/api/cron/outbox/route.ts": "크론 — 아웃박스 드레인은 이미 쌓인 사실의 후속 처리",
  "app/api/health/route.ts": "헬스체크 — 상태 보고",
  "app/api/test/login/route.ts": "테스트 로그인 — 테스트 환경 전용(ALLOW_TEST_LOGIN)",
  "lib/outbox/drain.ts": "아웃박스 드레인 — 크론·수동 버튼이 부르는 사실 처리(수동 버튼 자체는 OUTBOX_DRAIN_MANUAL 명령)",
};

// 화면 로더이지만 조회 명령이 아닌 것 — 레일 자체의 상태 안내라 스위치를 직접 읽는다.
const NOT_A_QUERY_LOADER: Record<string, string> = {
  "ui/views/shared/gate-banner.ts": "봉쇄 안내 배너 — 레일의 상태를 보여 줄 뿐 조회 명령이 아니다",
};

const RAIL_ENTRY = /\b(runCommand|runQuery|checkRail)\s*[<(]/;

describe("레일 입구 강제", () => {
  it("사실 처리 목록의 파일은 실제로 있다(없어진 예외가 남지 않게)", () => {
    const missing = Object.keys(FACT_PROCESSING).filter((f) => !existsSync(join(root, f)));
    expect(missing).toEqual([]);
  });

  it("서버 액션 파일('use server')과 route handler는 레일 입구(runCommand·runQuery·checkRail)를 거친다 — 사실 처리 5곳만 예외", () => {
    const entryFiles = appFiles.filter((f) => /(^|\/)route\.ts$/.test(f) || /^\s*["']use server["']/m.test(read(f)));
    // 이 검사가 빈 통과가 되지 않게 — 진입 파일이 실제로 잡혀야 한다.
    expect(entryFiles.length).toBeGreaterThanOrEqual(25);
    const outside = entryFiles.filter((f) => !(f in FACT_PROCESSING) && !RAIL_ENTRY.test(read(f)));
    expect(outside).toEqual([]);
  });

  it("사실 처리 파일은 레일 입구를 쓰지 않는다(쓰기 시작하면 이 목록에서 빼고 명령으로 올린다)", () => {
    const wrapped = Object.keys(FACT_PROCESSING).filter((f) => RAIL_ENTRY.test(read(f)));
    expect(wrapped).toEqual([]);
  });

  it("ui/views 조회 로더는 전부 runQuery를 거친다(로더 수 ≤ runQuery 호출 수) — 배너만 예외", () => {
    const loaderFiles = viewFiles.filter(
      (f) => !(f in NOT_A_QUERY_LOADER) && /\bexport\s+(?:async\s+function|const)\s+load[A-Z]\w*/.test(read(f)),
    );
    expect(loaderFiles.length).toBeGreaterThanOrEqual(25);
    const bad: string[] = [];
    for (const file of loaderFiles) {
      const code = read(file);
      const loaders = code.match(/\bexport\s+(?:async\s+function|const)\s+load[A-Z]\w*/g)?.length ?? 0;
      const queries = code.match(/\brunQuery\s*[<(]/g)?.length ?? 0;
      if (queries < loaders) bad.push(`${file}: 로더 ${loaders}개, runQuery ${queries}개`);
    }
    expect(bad).toEqual([]);
  });

  it("조회 예외 목록의 파일은 실제로 있다", () => {
    expect(Object.keys(NOT_A_QUERY_LOADER).filter((f) => !existsSync(join(root, f)))).toEqual([]);
  });
});

describe("감사·스위치 조회는 레일 안에서만", () => {
  // 감사 기록(recordAudit·getAuditSink)과 스위치 읽기(loadRailSwitches·readRailSwitches)는 lib/commands/·lib/audit/ 밖에서 직접 부르지 않는다.
  // 기록은 runCommand/runQuery가 남기고, 판정은 checkRail이 한다. 예외는 배너 한 곳(위 NOT_A_QUERY_LOADER).
  const DIRECT_CALL = /\b(recordAudit|getAuditSink|loadRailSwitches|readRailSwitches)\s*\(/;
  const ALLOWED_PREFIX = ["lib/commands/", "lib/audit/"];

  it("직접 호출이 없다", () => {
    const files = [...appFiles, ...libFiles, ...uiFiles, "proxy.ts"].filter(
      (f) => !ALLOWED_PREFIX.some((p) => f.startsWith(p)) && !(f in NOT_A_QUERY_LOADER),
    );
    const found = files.filter((f) => DIRECT_CALL.test(read(f)));
    expect(found).toEqual([]);
  });

  it("옛 게이트 판정 함수(assertGateOpen·isGateOpen)와 관리자 면제 기록(GATE_BYPASS_ADMIN)은 코드에 없다", () => {
    const files = [...appFiles, ...libFiles, ...uiFiles, "proxy.ts"];
    const found = files.filter((f) => /\b(assertGateOpen|isGateOpen|shouldBlock|GATE_BYPASS_ADMIN)\b/.test(read(f)));
    expect(found).toEqual([]);
  });
});

describe("명령 이름 ↔ 등록부", () => {
  // 코드가 명령·조회 이름을 쓰는 모양: command: "X"(runCommand·runQuery 호출부) / checkRail("X" / view: "X"(ADMIN_ROUTES) /
  // app/admin/orders/actions.ts의 삼항식 이름.
  function namesIn(code: string): string[] {
    return [
      ...code.matchAll(/\bcommand:\s*"([A-Z_]+)"/g),
      ...code.matchAll(/\bcheckRail\(\s*"([A-Z_]+)"/g),
      ...code.matchAll(/\bview:\s*"([A-Z_]+)"/g),
      ...code.matchAll(/\?\s*"(ORDER_[A-Z_]+)"\s*:/g),
      ...code.matchAll(/:\s*"(ORDER_[A-Z_]+)";/g),
    ].map((m) => m[1]);
  }

  const sources = [...appFiles, ...libFiles, ...uiFiles, "proxy.ts"].filter((f) => f !== "lib/commands/registry.ts");
  const used = new Set<string>();
  const unregistered: string[] = [];
  for (const file of sources) {
    for (const name of namesIn(read(file))) {
      used.add(name);
      if (!isCommandCode(name)) unregistered.push(`${file}: ${name}`);
    }
  }

  it("코드에 쓰인 명령·조회 이름은 전부 등록부에 있다(검사가 실제로 이름을 찾는다)", () => {
    expect(unregistered).toEqual([]);
    expect(used.size).toBeGreaterThanOrEqual(60);
  });

  it("등록부의 모든 명령·조회는 어딘가에서 쓰인다(안 쓰는 이름은 지운다)", () => {
    const unused = ALL_COMMANDS.filter((c) => !used.has(c.code)).map((c) => c.code);
    expect(unused).toEqual([]);
  });

  it("이름은 모듈을 넘어 유일하다", () => {
    const total = Object.values(COMMANDS_BY_MODULE).reduce((n, commands) => n + Object.keys(commands).length, 0);
    expect(ALL_COMMANDS).toHaveLength(total);
  });
});

describe("신고 ↔ 실제(진입 파일의 실제 쓰기 모듈 ⊆ 그 파일 명령들의 등록 모듈)", () => {
  // 방식은 boundaries.guard.test.ts의 tsWrites와 같다: .from("t") 뒤 같은 문장의 .insert/.update/.upsert/.delete → 테이블 주인,
  // .rpc("fn") → 함수 주인. CS 보고 창구(audit_logs·dead_letters·outbox_messages)에 쓰는 것은 어느 모듈의 일도 아니라 뺀다.
  function actualWriteModules(code: string): Set<ModuleName> {
    const modules = new Set<ModuleName>();
    const fromRe = /\.from\(\s*["']([a-z_]+)["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(code))) {
      const rest = code.slice(m.index + m[0].length, m.index + m[0].length + 400);
      const stmtEnd = rest.search(/;|\n\s*\n/);
      const stmt = stmtEnd === -1 ? rest : rest.slice(0, stmtEnd);
      const verb = stmt.match(/^\s*\.(insert|update|upsert|delete)\(/m) ?? stmt.match(/\.(insert|update|upsert|delete)\(/);
      if (!verb) continue;
      if (CS_SINK_TABLES.has(m[1])) continue;
      const owner = TABLE_OWNER[m[1]];
      if (owner) modules.add(owner);
    }
    const rpcRe = /\.rpc\(\s*["']([a-z_]+)["']/g;
    while ((m = rpcRe.exec(code))) {
      const owner = FUNCTION_OWNER[m[1]];
      if (owner) modules.add(owner);
    }
    // 결제 파사드(@/lib/payment)를 값으로 부르는 파일은 결제 모듈에 쓴다(파사드 안의 쓰기는 이 파일 밖에 있다).
    if (/import\s+(?!type\b)[^;]*from\s+["']@\/lib\/payment["']/.test(code)) modules.add("PAYMENT");
    return modules;
  }

  function declaredModules(code: string): Set<ModuleName> {
    const modules = new Set<ModuleName>();
    for (const m of [
      ...code.matchAll(/\bcommand:\s*"([A-Z_]+)"/g),
      ...code.matchAll(/\?\s*"(ORDER_[A-Z_]+)"\s*:/g),
      ...code.matchAll(/:\s*"(ORDER_[A-Z_]+)";/g),
    ]) {
      const def = ALL_COMMANDS.find((c) => c.code === m[1]);
      if (def) modules.add(def.module);
    }
    return modules;
  }

  it("runCommand를 쓰는 app/ 파일은 실제로 쓰는 모듈을 전부 명령으로 신고한다", () => {
    const callers = appFiles.filter((f) => /\brunCommand\s*[<(]/.test(read(f)));
    expect(callers.length).toBeGreaterThanOrEqual(20);
    const bad: string[] = [];
    for (const file of callers) {
      const code = read(file);
      const declared = declaredModules(code);
      for (const actual of actualWriteModules(code)) {
        if (!declared.has(actual)) {
          bad.push(`${file}: 실제 쓰기 ${actual} — 신고한 모듈 [${[...declared].join(",")}]`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("공리(통제실 통로)는 닫힌 집합이다", () => {
  it("공리는 정확히 6개이고 RAIL_SWITCH_SET은 CS 칸의 명령이다", () => {
    const axioms = ALL_COMMANDS.filter((c) => c.axiom).map((c) => c.code).sort();
    expect(axioms).toEqual(["ADMIN_SHELL_VIEW", "LOGIN", "LOGIN_VIEW", "LOGOUT", "RAIL_SWITCH_SET", "RAIL_SWITCH_VIEW"]);
    const set = ALL_COMMANDS.find((c) => c.code === "RAIL_SWITCH_SET");
    expect(set).toMatchObject({ module: "CS", kind: "COMMAND", who: "ADMIN" });
  });
});
