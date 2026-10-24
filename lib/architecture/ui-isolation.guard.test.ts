import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, posix, relative } from "path";

// 백엔드는 UI에 의존하지 않는다(2026-10-03 — 백엔드는 ui와 독립되어야 하고 ui에 의존하지 않아야 한다. ui는 껍데기다).
// UI는 ui/와 components/(이전 중 남은 옛 파일)에 있다. 아래 "백엔드 파일"이
// 그 두 폴더를 import하면 실패한다. UI → 백엔드 방향(화면이 액션·Loader를 쓰는 것)은 UI 쪽 가드(ui-layer.guard)가 따로 본다.
// 이 파일은 UI 폴더 이름만 알고 UI 파일 하나하나의 이름은 적지 않는다.
const root = process.cwd();
const UI_DIRS = ["ui", "components"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

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

// 백엔드 파일: lib/** 전부, proxy.ts, app/** 안의 .ts 전부(서버 액션·route handler·결제 복귀 헬퍼 등), 결제 모듈의 브라우저 쪽 부품 TossPayment.tsx.
// app/**의 .tsx(page·layout·error·화면 부품)는 UI 연결부라 대상이 아니다.
function isBackendFile(file: string): boolean {
  if (file.startsWith("lib/")) return true;
  if (file === "proxy.ts") return true;
  if (file === "app/student/payment/[orderId]/TossPayment.tsx") return true;
  return file.startsWith("app/") && file.endsWith(".ts");
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

function importTargets(file: string, code: string): string[] {
  const out: string[] = [];
  const re = /from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
  for (const m of stripLineComments(code).matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec.startsWith("@/")) out.push(spec.slice(2));
    else if (spec.startsWith(".")) out.push(posix.normalize(posix.join(dirname(file).replace(/\\/g, "/"), spec)));
  }
  return out;
}

describe("백엔드 → UI 의존 금지 가드", () => {
  it("lib/**·proxy.ts·app/**/*.ts·TossPayment.tsx는 ui/·components/를 import하지 않는다", () => {
    const files = [...collect(join(root, "lib")), ...collect(join(root, "app")), "proxy.ts"].filter(isBackendFile);
    const found: string[] = [];
    for (const file of files) {
      const code = readFileSync(join(root, file), "utf-8");
      for (const target of importTargets(file, code)) {
        if (UI_DIRS.some((d) => target === d || target.startsWith(`${d}/`))) found.push(`${file} -> ${target}`);
      }
    }
    expect(found).toEqual([]);
  });
});
