import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, normalize, relative } from "path";

// 프레젠테이션 레이어 경계 가드.
// UI(ui/**, ui/views 제외)는 데이터·결제·액션을 직접 만지지 않고, 조회·표시 규칙(ui/views/**)은 읽기만 하며, page.tsx는 얇다.
// 방식은 boundaries.guard.test.ts와 같다: 파일을 순회하고, 줄 주석을 뺀 뒤, 정규식으로 import·호출을 본다.
const root = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

function collect(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collect(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
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

type Import = { spec: string; typeOnly: boolean };

function isTypeOnlyClause(clause: string): boolean {
  const c = clause.trim();
  if (/^type\s/.test(c)) return true;
  const brace = c.match(/^\{([^}]*)\}$/);
  if (!brace) return false;
  const parts = brace[1].split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((s) => /^type\s/.test(s));
}

function importsOf(code: string): Import[] {
  const out: Import[] = [];
  let m: RegExpExecArray | null;
  const fromRe = /\b(?:import|export)\s+([^;"']*?)\s+from\s+["']([^"']+)["']/g;
  while ((m = fromRe.exec(code))) out.push({ spec: m[2], typeOnly: isTypeOnlyClause(m[1]) });
  const sideRe = /\bimport\s+["']([^"']+)["']/g;
  while ((m = sideRe.exec(code))) out.push({ spec: m[1], typeOnly: false });
  const dynRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynRe.exec(code))) out.push({ spec: m[1], typeOnly: false });
  return out;
}

function matchesAny(spec: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(spec));
}

function resolveRelative(file: string, spec: string): string {
  return normalize(join(dirname(file), spec)).replace(/\\/g, "/");
}

// ---- 1) ui/** (ui/views 제외) import 허용 목록 ---------------------------------------------
// cn: shadcn 4.x의 공식 cn 패키지(utils.ts는 `export { cn } from "cn"`, 부품도 패키지를 직접 import — 2026-10-03 실측).
const UI_PACKAGES = [/^react$/, /^radix-ui$/, /^@radix-ui\//, /^class-variance-authority$/, /^lucide-react$/, /^cn$/];
const NEXT_PACKAGES = [/^next\/link$/, /^next\/navigation$/];

type Area = {
  prefix: string;
  packages: RegExp[];
  aliases: RegExp[];
  typeOnlyAliases: RegExp[];
};

const AREAS: Area[] = [
  {
    prefix: "ui/lib/",
    packages: [/^cn$/],
    aliases: [],
    typeOnlyAliases: [],
  },
  {
    prefix: "ui/shadcn/",
    packages: UI_PACKAGES,
    aliases: [/^@\/ui\/lib\/utils$/, /^@\/ui\/shadcn\//],
    typeOnlyAliases: [],
  },
  {
    prefix: "ui/forms/",
    packages: UI_PACKAGES,
    aliases: [/^@\/ui\/lib\/utils$/, /^@\/ui\/shadcn\//, /^@\/ui\/forms\//],
    typeOnlyAliases: [/^@\/lib\/errors$/],
  },
  {
    prefix: "ui/shell/",
    packages: [...UI_PACKAGES, ...NEXT_PACKAGES],
    aliases: [/^@\/ui\/lib\/utils$/, /^@\/ui\/(shadcn|forms|shell)\//],
    typeOnlyAliases: [/^@\/lib\/errors$/, /^@\/ui\/views\//],
  },
  {
    prefix: "ui/screens/",
    packages: [...UI_PACKAGES, ...NEXT_PACKAGES],
    // ui/lib/는 cn 외 import가 없는 순수 도우미 자리다(위 ui/lib/ 영역) — 화면이 쓸 수 있다(예: 달력 날짜 계산 session-calendar).
    aliases: [/^@\/ui\/lib\//, /^@\/ui\/(shadcn|forms|shell|screens)\//],
    typeOnlyAliases: [/^@\/lib\/errors$/, /^@\/ui\/views\//],
  },
];

// ui/ 바로 아래에 올 수 있는 폴더(이 밖의 폴더·파일이 있으면 실패).
const UI_TOP_DIRS = ["shadcn", "forms", "shell", "screens", "views", "lib", "architecture"];

// UI-9에서 비어야 하는 목록 — 이전하면서 한 줄씩 지운다(추가 금지). 이미 옮겨져 없는 파일이 남아 있으면 그것도 실패한다.
const LEGACY_COMPONENT_ROOT_FILES: string[] = [];

function uiViolations(file: string, area: Area): string[] {
  const out: string[] = [];
  for (const { spec, typeOnly } of importsOf(read(file))) {
    if (spec.startsWith(".")) {
      if (!resolveRelative(file, spec).startsWith("ui/")) out.push(`${file} -> ${spec} (ui 밖 상대경로)`);
      continue;
    }
    if (spec.startsWith("@/")) {
      if (matchesAny(spec, area.aliases)) continue;
      if (typeOnly && matchesAny(spec, area.typeOnlyAliases)) continue;
      out.push(`${file} -> ${spec}`);
      continue;
    }
    if (!matchesAny(spec, area.packages)) out.push(`${file} -> ${spec} (허용 안 된 패키지)`);
  }
  return out;
}

// ---- 2) ui/views/** 읽기 전용 ----------------------------------------------------------
function writeCalls(code: string): string[] {
  const out: string[] = [];
  const fromRe = /\.from\(\s*["'][a-z_]+["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code))) {
    const rest = code.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const stmtEnd = rest.search(/;|\n\s*\n/);
    const stmt = stmtEnd === -1 ? rest : rest.slice(0, stmtEnd);
    const verb = stmt.match(/\.(insert|update|upsert|delete)\(/);
    if (verb) out.push(`${m[0]} .${verb[1]}(`);
  }
  if (/\.rpc\(/.test(code)) out.push(".rpc(");
  return out;
}

function viewViolations(file: string): string[] {
  const code = read(file);
  const out: string[] = [];
  for (const { spec } of importsOf(code)) {
    if (spec.startsWith("@/components/") || spec === "@/components") out.push(`${file} imports ${spec}`);
    if (spec.startsWith("@/app/")) out.push(`${file} imports ${spec}`);
    // 결제 파사드 export 전부가 facade-callers.ts의 "쓰기 export"로 등록돼 있다 — page가 import해서 인자로 넘긴다.
    if (spec === "@/lib/payment" || spec === "@/lib/payment/index") out.push(`${file} imports ${spec} (결제 파사드)`);
  }
  for (const w of writeCalls(code)) out.push(`${file} 쓰기 호출 ${w}`);
  return out;
}

// ---- 3) page.tsx 얇음 ---------------------------------------------------------------------
// 아직 이전하지 않은 page(UI-4~UI-8에서 한 줄씩 지운다 — 추가 금지). 이미 얇아진 page가 남아 있어도 실패한다.
const UNMIGRATED_PAGES: string[] = [];

// 화면이 없는 redirect 전용 page — 마크업이 없으니 className·supabase 서버 클라이언트 검사는 그대로 받고, 허용 import 목록 검사만 면제한다.
const REDIRECT_ONLY_PAGES: string[] = ["app/page.tsx"];

function thinIssues(code: string): string[] {
  const issues: string[] = [];
  if (/className=/.test(code)) issues.push("className=");
  if (/@\/lib\/supabase\/server/.test(code)) issues.push("@/lib/supabase/server");
  return issues;
}

function pageImportViolations(file: string): string[] {
  const out: string[] = [];
  for (const { spec } of importsOf(read(file))) {
    if (/^@\/ui\/(shadcn|forms|shell)\//.test(spec)) out.push(`${file} imports ${spec}`);
    // @/lib/ 아래는 결제 파사드(S6 — getRefundableAmount를 Loader에 인자로 넘긴다)만 허용.
    if (/^@\/lib\//.test(spec) && spec !== "@/lib/payment") out.push(`${file} imports ${spec}`);
  }
  return out;
}

describe("UI 레이어 경계 가드", () => {
  const allUiFiles = collect(join(root, "ui"));
  const uiFiles = allUiFiles.filter((f) => !f.startsWith("ui/views/") && !f.startsWith("ui/architecture/"));
  const viewFiles = collect(join(root, "ui/views"));
  const componentFiles = collect(join(root, "components"));
  const appFiles = collect(join(root, "app"));
  const pageFiles = appFiles.filter((f) => /(^|\/)page\.tsx$/.test(f));
  const layoutFiles = appFiles.filter((f) => /(^|\/)layout\.tsx$/.test(f));

  it("ui/shadcn·forms·shell·screens·lib는 허용 목록 밖을 import하지 않는다(@/app, 허용 외 @/lib, 허용 외 패키지 금지)", () => {
    const found: string[] = [];
    for (const file of uiFiles) {
      const area = AREAS.find((a) => file.startsWith(a.prefix));
      if (area) found.push(...uiViolations(file, area));
    }
    expect(found).toEqual([]);
  });

  it("ui/ 아래 최상위 폴더는 shadcn·forms·shell·screens·views·lib·architecture뿐이다", () => {
    const outside = allUiFiles.filter((f) => !UI_TOP_DIRS.includes(f.split("/")[1]) || f.split("/").length < 3).sort();
    expect(outside).toEqual([]);
  });

  it("components/ 루트에는 새 파일을 두지 않는다(옛 파일은 UI-2~UI-9에서 옮기며 목록에서 지운다)", () => {
    const rootFiles = componentFiles.filter((f) => f.split("/").length === 2);
    const unexpected = rootFiles.filter((f) => !LEGACY_COMPONENT_ROOT_FILES.includes(f)).sort();
    const stale = LEGACY_COMPONENT_ROOT_FILES.filter((f) => !rootFiles.includes(f)).sort();
    expect(unexpected).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("components/에는 하위 폴더가 없다(UI는 전부 ui/)", () => {
    const nested = componentFiles.filter((f) => f.split("/").length > 2).sort();
    expect(nested).toEqual([]);
  });

  it("ui/views는 components·app·결제 파사드를 import하지 않고 쓰기 호출(.insert/.update/.upsert/.delete/.rpc)이 없다", () => {
    const found = viewFiles.flatMap((f) => viewViolations(f));
    expect(found).toEqual([]);
  });

  it("Screen·Shell은 ui/shadcn/alert-dialog를 직접 import하지 않는다(확인 필수 창은 ui/forms의 Modal·ResultDialog만)", () => {
    const found: string[] = [];
    for (const file of uiFiles.filter((f) => /^ui\/(screens|shell)\//.test(f))) {
      for (const { spec } of importsOf(read(file))) {
        if (/^@\/ui\/shadcn\/alert-dialog$/.test(spec)) found.push(`${file} imports ${spec}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("이전이 끝난 page.tsx는 얇다(className·supabase 서버 클라이언트 없음, 허용 목록 밖 import 없음)", () => {
    const found: string[] = [];
    for (const file of pageFiles) {
      if (UNMIGRATED_PAGES.includes(file)) continue;
      const code = read(file);
      for (const issue of thinIssues(code)) found.push(`${file}: ${issue}`);
      if (!REDIRECT_ONLY_PAGES.includes(file)) found.push(...pageImportViolations(file));
    }
    expect(found).toEqual([]);
  });

  it("layout.tsx는 className을 쓰지 않는다(모양은 ui/shell이 맡는다, 단 최상위 폰트 설정용 html 태그 예외)", () => {
    const found = layoutFiles.filter((f) => {
      let code = read(f);
      if (f === "app/layout.tsx") {
        code = code.replace(/<html[^>]*className=\{cn\([^}]+\)\}/g, "<html>");
      }
      return /className=/.test(code);
    });
    expect(found).toEqual([]);
  });

  it("UNMIGRATED_PAGES에 이미 얇아졌거나 없는 page가 남아 있지 않다(고쳤으면 목록에서 지운다)", () => {
    const stale: string[] = [];
    for (const file of UNMIGRATED_PAGES) {
      if (!pageFiles.includes(file)) {
        stale.push(`${file}: 파일 없음`);
        continue;
      }
      if (thinIssues(read(file)).length === 0) stale.push(`${file}: 이미 얇음`);
    }
    expect(stale).toEqual([]);
  });
});
