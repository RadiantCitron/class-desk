import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

// app/·components/·ui/ 안의 정적 내부 링크·redirect가 실제 page.tsx/route.ts를 가리키는지 스캔한다
// (2026-09-27 라우팅 조사 후속 — /admin/managers 404와 같은 "표·링크는 있는데 페이지 없음" 재발 방지).
// 화면이 app/ 밖(ui/)으로 옮겨 가므로 순회 범위를 넓혔다. 없는 폴더는 건너뛴다.
// ${...}가 들어간 동적 경로는 검사하지 않는다(부모 [id] page 존재는 ADMIN_ROUTES 가드가 담당).
const ROOT = process.cwd();
const APP_ROOT = join(ROOT, "app");
const SCAN_ROOTS = [APP_ROOT, join(ROOT, "components"), join(ROOT, "ui")];

const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

function collectSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(relative(ROOT, full).replace(/\\/g, "/"));
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

function extractStaticInternalPaths(code: string): string[] {
  const stripped = stripLineComments(code);
  const paths: string[] = [];
  const patterns = [
    /href="(\/[^"]+)"/g,
    /href='(\/[^']+)'/g,
    /href:\s*"(\/[^"]+)"/g,
    /href:\s*'(\/[^']+)'/g,
    /redirect\("(\/[^"]+)"\)/g,
    /redirect\('(\/[^']+)'\)/g,
    /redirect\(`(\/[^`$]+)`\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      paths.push(match[1].split("?")[0].split("#")[0]);
    }
  }
  return paths;
}

function staticAppRouteExists(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const dir = segments.length === 0 ? APP_ROOT : join(APP_ROOT, ...segments);
  return existsSync(join(dir, "page.tsx")) || existsSync(join(dir, "route.ts"));
}

describe("정적 내부 링크 가드(app·components·ui)", () => {
  it("Link·redirect의 정적 /... 경로가 app/**/page.tsx 또는 route.ts에 매핑된다", () => {
    const files = SCAN_ROOTS.flatMap((dir) => collectSourceFiles(dir));
    const broken: string[] = [];

    for (const file of files) {
      const code = readFileSync(join(ROOT, file), "utf-8");
      for (const path of extractStaticInternalPaths(code)) {
        if (!staticAppRouteExists(path)) {
          broken.push(`${file}: ${path}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });
});
