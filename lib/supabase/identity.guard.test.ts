import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

// 구조적 강제 테스트(2026-09-12 식별자 분리) — "auth.uid()/auth.getUser()가
// 반환하는 auth.users.id"와 "public.users.id(=Profile.id)"를 헷갈리면 RLS는 통과하는데 남의
// 데이터를 건드리는 사고가 난다(TS는 둘 다 그냥 string이라 컴파일러가 못 잡는다). 그래서 이
// 매핑을 아는 코드를 파일 단위로 못 박아둔다 — 새 코드가 실수로 auth.getUser()를 직접 부르거나
// 'auth_user_id' 컬럼명을 다시 하드코딩하면, 리뷰 전에 이 테스트가 먼저 걸린다.
//
// 허용 목록:
//  - lib/supabase/identity.ts — 세션→프로필 변환의 유일한 지점. auth.getUser()를 감싸는
//    getCurrentAuthUser()/getCurrentProfile()이 여기 있고, 'auth_user_id' 컬럼도 여기서만 쓴다.
//  - lib/supabase/middleware.ts — proxy.ts용 요청 스코프 클라이언트를 만드는 곳. next/headers의
//    cookies()를 못 쓰는 proxy 환경이라 자기만의 auth.getUser() 호출이 따로 필요하다.
const ALLOWED_FILES = new Set([
  "lib/supabase/identity.ts",
  "lib/supabase/middleware.ts",
]);

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "supabase", "e2e"]);

function collectSourceFiles(dir: string, root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectSourceFiles(full, root));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) {
      out.push(relative(root, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

// 코드 자체의 호출/참조만 본다 — 이 파일들을 설명하는 주석(다른 파일에서 "auth_user_id 컬럼
// 지식은 identity.ts에만 둔다"처럼 언급하는 것)까지 걸리면 오탐이라 라인 단위로 `//` 주석을
// 잘라내고 검사한다(이 저장소는 블록 주석을 쓰지 않는다 — 실제로 걸린다면 그건 그것대로
// 알아야 할 신호다).
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

describe("식별자 분리 구조 가드 — auth.getUser()/auth_user_id는 허용된 파일에서만", () => {
  const root = process.cwd();
  const files = collectSourceFiles(root, root).filter((f) => !ALLOWED_FILES.has(f));

  it("auth.getUser()는 lib/supabase/identity.ts, lib/supabase/middleware.ts 밖에서 호출되지 않는다", () => {
    const offenders = files.filter((f) => {
      const code = stripLineComments(readFileSync(join(root, f), "utf-8"));
      return /\.auth\.getUser\s*\(/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("'auth_user_id' 컬럼명은 lib/supabase/identity.ts 밖에서 참조되지 않는다", () => {
    // 단어 경계(\b)로 잡는다 — complete_signup()의 RPC 파라미터 p_auth_user_id처럼 다른
    // 식별자의 일부로 들어간 경우(밑줄은 \b 기준으로 단어 문자라 경계가 안 생긴다)는 컬럼명을
    // 다시 하드코딩한 게 아니라 별개의, 이미 검토된 이름이므로 오탐이 아니게 제외한다.
    const offenders = files.filter((f) => {
      const code = stripLineComments(readFileSync(join(root, f), "utf-8"));
      return /\bauth_user_id\b/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("허용 목록에 실존하지 않는 파일이 남아있지 않다(오래된 화이트리스트 방지)", () => {
    for (const f of ALLOWED_FILES) {
      expect(() => statSync(join(root, f))).not.toThrow();
    }
  });
});
