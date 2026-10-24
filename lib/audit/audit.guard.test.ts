import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

// 구조적 강제 테스트(identity.guard.test.ts/gates.guard.test.ts 선례) — 2026-09-20 감사 모듈
// 재설계에서 정한 경계 세 가지를 코드 리뷰가 아니라 테스트로 고정한다.
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "supabase", "e2e"]);
const root = process.cwd();

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) {
      out.push(relative(root, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

// "audit_logs" 문자열을 적어도 되는 파일(허용 목록). 파일을 옮기거나 지우면 이 목록도 함께 고친다 — 아래 실존 검사가 오래된 항목을 잡는다.
const ALLOWED = new Set([
  "lib/audit/sinks/postgres.ts",
  // audit_logs 읽기의 유일한 곳(2026-10-03 선행작업 A-3). 화면은 이 파일의 함수를 부른다.
  "lib/audit/read.ts",
  "app/api/health/route.ts",
  // 모듈 지도는 테이블 소유권 이름만 적는다(·1-4-6). 이 파일은 audit_logs를 조회하거나 쓰지 않는다.
  "lib/architecture/module-map.ts",
]);

const allFiles = collectSourceFiles(root);
const auditFiles = allFiles.filter((f) => f.startsWith("lib/audit/"));

describe("감사 모듈 구조 가드", () => {
  it("lib/audit/**는 lib/integrity를 import하지 않는다 — 감사와 무결성점검은 형제 관계이지 상하 관계가 아니다", () => {
    const offenders = auditFiles.filter((f) => {
      const code = stripLineComments(readFileSync(join(root, f), "utf-8"));
      return /lib\/integrity/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("lib/audit/failure.ts는 lib/audit(자기 자신의 index)를 import하지 않는다 — 감사 실패 보고가 다시 감사를 시도하면 무한 루프가 된다", () => {
    const code = stripLineComments(readFileSync(join(root, "lib/audit/failure.ts"), "utf-8"));
    expect(code).not.toMatch(/from ["']\.\/index["']/);
    expect(code).not.toMatch(/from ["']@\/lib\/audit["']/);
  });

  it('"audit_logs" 테이블 참조는 정해진 파일 밖에 나타나지 않는다(쓰기는 sinks/postgres.ts 한 곳, 읽기는 조회 화면·헬스체크뿐, 이름만 적는 모듈 지도는 예외)', () => {
    const offenders = allFiles.filter((f) => {
      if (ALLOWED.has(f)) return false;
      const code = stripLineComments(readFileSync(join(root, f), "utf-8"));
      return /"audit_logs"/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("허용 목록에 실존하지 않는 파일이 남아있지 않다(오래된 화이트리스트 방지 — identity.guard.test.ts와 같은 검사)", () => {
    for (const f of ALLOWED) {
      expect(() => statSync(join(root, f)), f).not.toThrow();
    }
  });
});
