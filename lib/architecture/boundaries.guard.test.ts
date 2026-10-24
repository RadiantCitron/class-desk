import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import {
  TABLE_OWNER,
  CS_SINK_TABLES,
  FUNCTION_OWNER,
  PERMANENT_CROSS_WRITES,
  PERMANENT_TS_RPC_EXCEPTIONS,
  CS_READ_ONLY_EXCEPTIONS,
  FACT_TOPICS,
  SDK_IMPORT_ALLOWED,
  SHARED_TABLE_ACCESS_EXCEPTIONS,
  fileKind,
  type ModuleName,
} from "./module-map";

// 경계 가드 테스트 — "기능 추가할 때마다 어디가 터질지 모르는 상태는 용납할
// 수 없다"를 사람의 기억이 아니라 테스트로 강제한다(R1·R2·R3·R4·R6 + 삭제 금지).
// R5(외주 SDK는 어댑터에서만)는 기존 identity.guard.test.ts·facade-boundary.guard.test.ts가 맡고, 이 파일은 SDK 패키지를
// 값으로 import하는 곳이 어댑터(SDK_IMPORT_ALLOWED)뿐인지 본다(예전엔 인증 복귀 라우트 2곳이
// @supabase/ssr을 직접 불러도 걸리지 않았다).
//
// KNOWN_VIOLATIONS는 "지금 이미 있는 위반" 목록이다. 새 위반만 실패시키고,
// 이미 있는 위반은 고치는 단계(단계별 정리)에서 한 줄씩 지운다. 목록에 있는데 실제로는 이미
// 고쳐진 항목이 남아 있으면 그것도 실패시킨다(오래된 예외가 쌓이지 않게). 이 목록에 줄을 "추가"하는
// 것은 금지다 — 새 위반은 설계대로 고치거나, 설계 자체를 사용자와 다시 정한다.
const KNOWN_VIOLATIONS = new Set<string>([
]);

// 업무 모듈 간 읽기 금지의 "지금 있는 위반" 목록. A~D단계에서 한 줄씩 지운다.
// 이 목록에 줄을 "추가"하는 것은 금지다.
const KNOWN_READ_VIOLATIONS = new Set<string>([]);

// 상태를 바꾸는 서버 액션 파일(app/**/actions.ts)은 CS 명령 파이프라인 안에서만 쓴다
// 예전에는 "행위자(users.id)가 아직 없는" 가입·로그인 링크 요청 2곳이 예외였다. 명령 레일 CR-6(2026-10-07)부터
// 신원 전 명령(who: PUBLIC)도 runCommand를 지나므로 예외는 없다 — 이 목록에 줄을 추가하는 것은 금지다.
// (레일 입구 전체 강제와 신고·실제 대조는 lib/commands/rail.guard.test.ts가 맡는다.)
const PIPELINE_EXEMPT_FILES: Record<string, string> = {};

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "supabase", "e2e", "docs", "public"]);

function collectSourceFiles(dir: string, root: string): string[] {
  if (!existsSync(dir)) return []; // 폴더가 없어도 통과(ui/는 UI-1 전에 없고, components/는 UI-9 뒤에 없다)
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectSourceFiles(full, root));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(relative(root, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

// 주석(// ...)은 검사에서 뺀다 — 설명문 속 테이블 이름이 오탐되지 않게.
function stripLineComments(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

// 마이그레이션을 파일명 순서로 읽어 "지금 유효한" 함수 본문만 남긴다
// (나중 파일의 create or replace가 앞의 것을 덮어쓰고, drop function은 지운다).
function loadFinalFunctionBodies(root: string): Map<string, string> {
  const dir = join(root, "supabase", "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const bodies = new Map<string, string>();
  const eventRe = /(create\s+(?:or\s+replace\s+)?function|drop\s+function(?:\s+if\s+exists)?)\s+(?:public\.)?([a-z_]+)\s*\(/gi;

  for (const file of files) {
    const sql = stripSqlComments(readFileSync(join(dir, file), "utf-8"));
    let m: RegExpExecArray | null;
    eventRe.lastIndex = 0;
    while ((m = eventRe.exec(sql))) {
      const kind = m[1].toLowerCase();
      const name = m[2].toLowerCase();
      if (kind.startsWith("drop")) {
        bodies.delete(name);
        continue;
      }
      const start = sql.indexOf("$$", m.index);
      const end = start === -1 ? -1 : sql.indexOf("$$", start + 2);
      if (start === -1 || end === -1) continue;
      bodies.set(name, sql.slice(start + 2, end));
    }
  }
  return bodies;
}

const SQL_NOISE_WORDS = new Set(["set", "skip", "nowait", "of"]);

type Found = string;

function checkSql(root: string): Found[] {
  const found: Found[] = [];
  const bodies = loadFinalFunctionBodies(root);
  const writeRe = /\b(insert\s+into|update|delete\s+from)\s+(?:public\.)?([a-z_]+)\b/gi;
  const topicRe = /insert\s+into\s+(?:public\.)?outbox_messages\s*\(\s*topic\s*,\s*payload\s*\)\s*values\s*\(\s*'([A-Z_]+)'/gi;

  for (const [fn, body] of bodies) {
    let m: RegExpExecArray | null;
    writeRe.lastIndex = 0;
    while ((m = writeRe.exec(body))) {
      const verb = m[1].toLowerCase().replace(/\s+/g, " ");
      const table = m[2].toLowerCase();
      if (SQL_NOISE_WORDS.has(table)) continue;
      if (!(table in TABLE_OWNER)) {
        found.push(`SQL-UNKNOWN-TABLE ${fn} -> ${table}`);
        continue;
      }
      if (verb === "delete from") {
        found.push(`SQL-DELETE ${fn} -> ${table}`);
        continue;
      }
      if (CS_SINK_TABLES.has(table) && verb === "insert into") continue;
      const owner = FUNCTION_OWNER[fn];
      if (!owner) {
        found.push(`SQL-UNOWNED-FUNCTION ${fn}`);
        continue;
      }
      if (TABLE_OWNER[table] === owner) continue;
      if (PERMANENT_CROSS_WRITES.some((p) => p.fn === fn && p.table === table)) continue;
      found.push(`SQL-WRITE ${fn} -> ${table}`);
    }

    topicRe.lastIndex = 0;
    while ((m = topicRe.exec(body))) {
      if (!(FACT_TOPICS as readonly string[]).includes(m[1])) {
        found.push(`TOPIC ${m[1]} in SQL ${fn}`);
      }
    }

    // R1(읽기) — 업무 모듈 소유 DB 함수가 다른 업무 모듈 테이블을 SELECT하면 위반이다
    // CS 소유 함수는 예외(읽기는 CS의 일). CS 창구 테이블(outbox_messages·
    // dead_letters·audit_logs)의 멱등 확인 조회는 항상 허용(기존 관례).
    const readRe = /\b(?:from|join)\s+(?:public\.)?([a-z_]+)\b/gi;
    const owner = FUNCTION_OWNER[fn];
    let rm: RegExpExecArray | null;
    readRe.lastIndex = 0;
    while ((rm = readRe.exec(body))) {
      const table = rm[1].toLowerCase();
      if (SQL_NOISE_WORDS.has(table) || table === "public") continue;
      if (!(table in TABLE_OWNER)) continue;
      if (CS_SINK_TABLES.has(table)) continue;
      if (owner === "CS") continue;
      if (owner && TABLE_OWNER[table] === owner) continue;
      found.push(`SQL-READ ${fn}(${owner}) -> ${table}(${TABLE_OWNER[table]})`);
    }
  }
  return found;
}

// supabase-js 호출에서 "어느 테이블에 쓰는가"를 뽑는다: .from("t") 뒤 같은 문장 안의
// .insert( / .update( / .upsert( / .delete(. 그리고 .rpc("fn")은 FUNCTION_OWNER로 모듈을 정한다.
function tsWrites(code: string): { table?: string; fn?: string; verb: string }[] {
  const out: { table?: string; fn?: string; verb: string }[] = [];
  const fromRe = /\.from\(\s*["']([a-z_]+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code))) {
    const rest = code.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const stmtEnd = rest.search(/;|\n\s*\n/);
    const stmt = stmtEnd === -1 ? rest : rest.slice(0, stmtEnd);
    const verb = stmt.match(/^\s*\.(insert|update|upsert|delete)\(/m) ?? stmt.match(/\.(insert|update|upsert|delete)\(/);
    if (verb) out.push({ table: m[1], verb: verb[1] });
  }
  const rpcRe = /\.rpc\(\s*["']([a-z_]+)["']/g;
  while ((m = rpcRe.exec(code))) {
    out.push({ fn: m[1], verb: "rpc" });
  }
  return out;
}

function importTargets(code: string): string[] {
  const out: string[] = [];
  const re = /from\s+["']@\/([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.push(m[1]);
  return out;
}

function kindOfImport(target: string) {
  // "lib/terms" → lib/terms.ts, "lib/payment" → lib/payment/ 등. 확장자 없는 경로를 둘 다 시도한다.
  return fileKind(`${target}.ts`) ?? fileKind(`${target}/`) ?? fileKind(target);
}

// `import type {…}`이나 `import { type A, type B }`처럼 타입만 가져오는 import인가(런타임에 SDK를 싣지 않는다).
function isTypeOnlyImport(clause: string): boolean {
  const c = clause.trim();
  if (/^type\s/.test(c)) return true;
  const brace = c.match(/^\{([^}]*)\}$/);
  if (!brace) return false;
  const parts = brace[1].split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((s) => /^type\s/.test(s));
}

function sdkImportViolations(file: string, code: string): Found[] {
  const out: Found[] = [];
  const re = /import\s+([^;]*?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const [, clause, pkg] = m;
    const rule = SDK_IMPORT_ALLOWED.find((r) => r.pkg.test(pkg));
    if (!rule || isTypeOnlyImport(clause)) continue;
    if (rule.prefixes.some((p) => file.startsWith(p))) continue;
    out.push(`R5-SDK-IMPORT ${file} -> ${pkg}`);
  }
  return out;
}

function checkTs(root: string): Found[] {
  const found: Found[] = [];
  const files = [
    ...collectSourceFiles(join(root, "app"), root),
    ...collectSourceFiles(join(root, "lib"), root),
    ...collectSourceFiles(join(root, "components"), root),
    ...collectSourceFiles(join(root, "ui"), root),
    "proxy.ts",
  ];

  for (const file of files) {
    const kind = fileKind(file);
    if (!kind) {
      found.push(`TS-UNMAPPED-FILE ${file}`);
      continue;
    }
    const code = stripLineComments(readFileSync(join(root, file), "utf-8"));
    found.push(...sdkImportViolations(file, code));
    const sharedTableException = SHARED_TABLE_ACCESS_EXCEPTIONS.some((p) => file.startsWith(p));

    // 쓰기 대상 모듈 수집
    const writtenModules = new Set<ModuleName>();
    for (const w of tsWrites(code)) {
      if (w.table) {
        if (!(w.table in TABLE_OWNER)) {
          found.push(`TS-UNKNOWN-TABLE ${file} -> ${w.table}`);
          continue;
        }
        if (w.verb === "delete") {
          found.push(`TS-DELETE ${file} -> ${w.table}`);
          continue;
        }
        // F-3: 개설강의·회차 테이블은 앱 코드에서 직접 쓰지 않는다 (RPC 강제)
        if (w.table === "course_offerings" || w.table === "course_sessions") {
          found.push(`TS-OFFERING-DIRECT-WRITE ${file} -> ${w.table} (${w.verb})`);
          continue;
        }
        if (CS_SINK_TABLES.has(w.table) && w.verb === "insert") continue;
        const owner = TABLE_OWNER[w.table];
        writtenModules.add(owner);
        if (kind === "SHARED" && !sharedTableException) {
          found.push(`TS-SHARED-WRITE ${file} -> ${w.table} (${owner})`);
        } else if (kind !== "ENTRY" && kind !== "WIRING" && kind !== "SHARED" && owner !== kind) {
          found.push(`TS-WRITE ${file} (${kind}) -> ${w.table} (${owner})`);
        }
      } else if (w.fn) {
        const owner = FUNCTION_OWNER[w.fn];
        if (!owner) continue; // 읽기 전용 함수(is_admin 등) 호출
        writtenModules.add(owner);
        if (PERMANENT_TS_RPC_EXCEPTIONS.some((p) => p.file === file && p.fn === w.fn)) continue;
        if (kind !== "ENTRY" && kind !== "WIRING" && kind !== "SHARED" && owner !== kind) {
          found.push(`TS-RPC ${file} (${kind}) -> ${w.fn} (${owner})`);
        }
      }
    }

    // 진입점 파일 하나가 두 모듈 이상을 쓰면 안 된다
    if (kind === "ENTRY" && writtenModules.size > 1) {
      found.push(`ENTRY-MULTI-WRITE ${file} -> ${[...writtenModules].sort().join(",")}`);
    }

    // 쓰기가 있는 서버 액션 파일은 runCommand(또는 그 편의 입구)를 거쳐야 한다
    if (
      /^app\/.*actions\.ts$/.test(file) &&
      tsWrites(code).length > 0 &&
      !/\brun(Admin|Staff)?Command\(/.test(code) &&
      !(file in PIPELINE_EXEMPT_FILES)
    ) {
      found.push(`ENTRY-WRITE-OUTSIDE-PIPELINE ${file}`);
    }

    // R1(읽기) — 업무 모듈 소속 TS 파일이 다른 업무 모듈 테이블을 .select()로 읽으면 위반이다
    // CS는 예외(가드·대사가 여러 모듈을 보는 게 원래 일).
    const selectFromRe = /\.from\(\s*["']([a-z_]+)["']\s*\)\s*\n?\s*\.select\(/g;
    let sm: RegExpExecArray | null;
    selectFromRe.lastIndex = 0;
    while ((sm = selectFromRe.exec(code))) {
      const table = sm[1];
      if (!(table in TABLE_OWNER)) continue;
      if (CS_SINK_TABLES.has(table)) continue;
      // SHARED(기반 코드)는 업무 테이블을 읽지 않는다 — 읽는다면 그건 기반이 아니라 어느 모듈의 일이다(#16).
      if (kind === "SHARED" && !sharedTableException) {
        found.push(`TS-SHARED-READ ${file} -> ${table} (${TABLE_OWNER[table]})`);
        continue;
      }
      if (kind === "ENTRY" || kind === "WIRING" || kind === "SHARED" || kind === "CS") continue;
      const owner = TABLE_OWNER[table];
      if (owner !== kind) {
        found.push(`TS-READ ${file} (${kind}) -> ${table} (${owner})`);
      }
    }

    // R1(import) — 업무 모듈끼리 import 금지 / R4 — CS 코어는 업무 모듈 import 금지
    // 모듈의 이벤트 핸들러(…/handlers)는 연동표(lib/wiring/)에서만 import한다
    for (const target of importTargets(code)) {
      if (/(^|\/)handlers$/.test(target) && kind !== "WIRING") {
        found.push(`R3-HANDLER-IMPORT ${file} -> ${target}`);
      }
      const targetKind = kindOfImport(target);
      if (!targetKind || targetKind === "SHARED" || targetKind === "ENTRY" || targetKind === "WIRING") continue;
      if (kind === "ENTRY" || kind === "WIRING" || kind === "SHARED") continue;
      if (targetKind === kind) continue;
      if (kind === "CS" && CS_READ_ONLY_EXCEPTIONS.some((p) => file.startsWith(p))) continue;
      found.push(`TS-IMPORT ${file} (${kind}) -> ${target} (${targetKind})`);
    }

    // 아웃박스 토픽은 사실형만
    const topicRe = /topic:\s*["']([A-Z_]+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = topicRe.exec(code))) {
      if (!(FACT_TOPICS as readonly string[]).includes(m[1])) {
        found.push(`TOPIC ${m[1]} in ${file}`);
      }
    }
  }
  return found;
}

describe("모듈 경계 가드(R1·R2·R3·R4·R6 + 삭제 금지)", () => {
  const root = process.cwd();
  const found = [...checkSql(root), ...checkTs(root)];
  const known = new Set([...KNOWN_VIOLATIONS, ...KNOWN_READ_VIOLATIONS]);
  const unexpected = found.filter((f) => !known.has(f)).sort();
  const stale = [...known].filter((k) => !found.includes(k)).sort();

  it("새 경계 위반이 없다(있으면 module-map.ts에 소속을 적거나 설계대로 고친다)", () => {
    expect(unexpected).toEqual([]);
  });

  it("이미 고쳐진 위반이 KNOWN_VIOLATIONS에 남아 있지 않다(고쳤으면 목록에서 지운다)", () => {
    expect(stale).toEqual([]);
  });

  it("F-3: 앱 코드의 개설강의·회차 직접 쓰기를 가드가 감지한다 (자기 시험)", () => {
    const fakeCode = `
      await supabase.from("course_offerings").insert({ label: "test" });
      await supabase.from("course_sessions").update({ session_date: "2026-10-10" });
    `;
    const writes = tsWrites(fakeCode);
    expect(writes).toEqual([
      { table: "course_offerings", verb: "insert" },
      { table: "course_sessions", verb: "update" },
    ]);
  });
});
