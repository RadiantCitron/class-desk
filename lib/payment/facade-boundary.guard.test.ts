import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { PAYMENT_FACADE_CALLERS } from "./facade-callers";

// 구조적 강제 테스트(identity.guard.test.ts/gates.guard.test.ts 선례) — "결제경로는
// 하나여야 한다"를 코드 리뷰가 아니라 테스트로 고정한다.
// lib/payment/index.ts(startCheckout/confirmPayment)가 유일한 공개 입구이고, 그 안에서만
// 실제 PG 연동(lib/payment/providers)을 부른다(자격 판정은 에서 CS 가드
// lib/guards/checkout으로 옮겼다).
// 새 코드가 실수로 app/** 어딘가에서 이 내부 모듈을 직접 불러 파사드를 우회하면, "결제
// 시작 경로가 두 갈래가 되는" 스파게티가 다시 생긴다 — 리뷰 전에 이 테스트가 먼저 걸린다.
//
// PG-8: app/mock-pg 제거. 토스 결제 컴포넌트(app/student/payment/[orderId]/TossPayment.tsx)는 providers를 import하지
// 않는다(값은 서버 액션이 돌려준 clientParams만 — 2026-10-02, 이전엔 /pg/toss/launch 쿼리). 웹훅 라우트는 ingestWebhook(lib/payment)만 부른다.
//
// 파사드 쓰기 export는 facade-callers.ts 허용
// 접두사에서만 import한다. 표에 없는 이름(PaymentWebhookError 등)은 이 it의 대상이 아니다.
const EXEMPT_FILES = new Set<string>();
const EXEMPT_DIR_PREFIXES: string[] = [];

const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

function collectSourceFiles(dir: string, root: string): string[] {
  if (!existsSync(dir)) return []; // 폴더가 없어도 통과(ui/는 UI-1 전에 없고, components/는 UI-9 뒤에 없다)
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectSourceFiles(full, root));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(relative(root, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

/** `import { type X, Y as Z } from "..."` 에서 심볼 이름(별칭이면 원본)만 뽑는다. */
function extractImportedNames(stmt: string): string[] {
  const brace = stmt.match(/import\s*(?:type\s*)?\{([^}]+)\}/);
  if (!brace) return [];
  return brace[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const withoutType = part.replace(/^type\s+/, "");
      const beforeAs = withoutType.split(/\s+as\s+/)[0]?.trim() ?? "";
      return beforeAs;
    })
    .filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
}

/** F-16: import type / import * / export from / 동적 import까지 잡는다. */
function facadeImportStatements(code: string): string[] {
  const patterns = [
    /import\s*(?:type\s*)?\{[^}]+\}\s*from\s*["']@\/lib\/payment(?:\/index)?["']/g,
    /import\s*\*\s*as\s+\w+\s*from\s*["']@\/lib\/payment(?:\/index)?["']/g,
    /export\s*(?:type\s*)?\{[^}]+\}\s*from\s*["']@\/lib\/payment(?:\/index)?["']/g,
    /import\s*\(\s*["']@\/lib\/payment(?:\/index)?["']\s*\)/g,
  ];
  const out: string[] = [];
  for (const re of patterns) {
    const m = code.match(re);
    if (m) out.push(...m);
  }
  return out;
}

describe("결제 파사드 경계 가드 — app/** 은 lib/payment/index.ts로만 결제한다", () => {
  const root = process.cwd();
  const appFiles = collectSourceFiles(join(root, "app"), root).filter(
    (f) => !EXEMPT_FILES.has(f) && !EXEMPT_DIR_PREFIXES.some((p) => f.startsWith(p)),
  );
  const libComponentFiles = [
    ...collectSourceFiles(join(root, "lib"), root),
    ...collectSourceFiles(join(root, "components"), root),
    ...collectSourceFiles(join(root, "ui"), root),
  ].filter(
    (f) =>
      !f.startsWith("lib/payment/") &&
      !EXEMPT_FILES.has(f) &&
      !EXEMPT_DIR_PREFIXES.some((p) => f.startsWith(p)),
  );

  it("app/**은 lib/payment/providers를 직접 import하지 않는다", () => {
    const offenders = appFiles.filter((f) => {
      const code = readFileSync(join(root, f), "utf-8");
      return /["']@\/lib\/payment\/providers/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("app/**은 record_payment_event RPC를 직접 부르지 않는다(확정은 confirmPayment()로만)", () => {
    const offenders = appFiles.filter((f) => {
      const code = readFileSync(join(root, f), "utf-8");
      return /\.rpc\(\s*["']record_payment_event["']/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("웹훅 라우트는 프로바이더 예외가 아니고, 토스 결제 컴포넌트는 결제 페이지에 있다(중간 이동 페이지 제거됨)", () => {
    expect(EXEMPT_FILES.has("app/api/webhooks/payment/[provider]/route.ts")).toBe(false);
    expect(statSync(join(root, "app/student/payment/[orderId]/TossPayment.tsx")).isFile()).toBe(true);
  });

  it("app/**은 파사드 쓰기 export를 허용 접두사에서만 import한다", () => {
    const offenders: string[] = [];
    for (const f of appFiles) {
      const code = readFileSync(join(root, f), "utf-8");
      for (const stmt of facadeImportStatements(code)) {
        if (/import\s*\*/.test(stmt) || /import\s*\(/.test(stmt)) {
          offenders.push(`${f}: namespace/dynamic import of payment facade`);
          continue;
        }
        for (const name of extractImportedNames(stmt)) {
          if (!(name in PAYMENT_FACADE_CALLERS)) continue;
          const allowed =
            PAYMENT_FACADE_CALLERS[name as keyof typeof PAYMENT_FACADE_CALLERS];
          const ok = allowed.some((prefix) => f.startsWith(prefix));
          if (!ok) offenders.push(`${f} imports ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("lib/**·components/**·ui/**은 결제 파사드 쓰기 export를 import하지 않는다", () => {
    const writeNames = new Set(Object.keys(PAYMENT_FACADE_CALLERS));
    const offenders: string[] = [];
    for (const f of libComponentFiles) {
      const code = readFileSync(join(root, f), "utf-8");
      for (const stmt of facadeImportStatements(code)) {
        if (/import\s*\*/.test(stmt) || /import\s*\(/.test(stmt)) {
          offenders.push(`${f}: namespace/dynamic import`);
          continue;
        }
        for (const name of extractImportedNames(stmt)) {
          if (writeNames.has(name)) offenders.push(`${f} imports ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("facade-callers 표 키는 index.ts 쓰기 함수 export와 일치한다", () => {
    const indexSrc = readFileSync(join(root, "lib/payment/index.ts"), "utf-8");
    const writeExports = [
      ...indexSrc.matchAll(/^export async function (\w+)/gm),
    ].map((m) => m[1]);
    expect(writeExports.sort()).toEqual([...Object.keys(PAYMENT_FACADE_CALLERS)].sort());
  });
});
