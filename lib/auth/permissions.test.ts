import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import {
  ADMIN_ROUTES,
  resolvePermissions,
  hasPermission,
  formatPermissions,
  canAccessAdminRoute,
  findAdminRoute,
  adminOnlyRoutePaths,
  whoDenial,
} from "./permissions";
import { commandDef } from "@/lib/commands/registry";

describe("resolvePermissions", () => {
  it("ADMIN은 항상 전부 true", () => {
    expect(resolvePermissions("ADMIN", null)).toEqual({
      viewStudents: true,
      approveOrders: true,
      approvePayments: true,
    });
  });

  it("STUDENT는 항상 전부 false", () => {
    expect(resolvePermissions("STUDENT", null)).toEqual({
      viewStudents: false,
      approveOrders: false,
      approvePayments: false,
    });
  });

  it("MANAGER는 권한 행이 없으면 전부 false", () => {
    expect(resolvePermissions("MANAGER", null)).toEqual({
      viewStudents: false,
      approveOrders: false,
      approvePayments: false,
    });
  });

  it("MANAGER는 권한 행의 칼럼값을 그대로 따른다", () => {
    expect(
      resolvePermissions("MANAGER", {
        canViewStudents: true,
        canApproveOrders: false,
        canApprovePayments: true,
        revokedAt: null,
      }),
    ).toEqual({ viewStudents: true, approveOrders: false, approvePayments: true });
  });

  it("MANAGER는 박탈(revokedAt)됐으면 칼럼이 true여도 전부 false", () => {
    expect(
      resolvePermissions("MANAGER", {
        canViewStudents: true,
        canApproveOrders: true,
        canApprovePayments: true,
        revokedAt: "2026-09-18T00:00:00Z",
      }),
    ).toEqual({ viewStudents: false, approveOrders: false, approvePayments: false });
  });
});

describe("hasPermission", () => {
  const perms = { viewStudents: true, approveOrders: false, approvePayments: false };
  it("VIEW_STUDENTS", () => expect(hasPermission(perms, "VIEW_STUDENTS")).toBe(true));
  it("APPROVE_ORDERS", () => expect(hasPermission(perms, "APPROVE_ORDERS")).toBe(false));
  it("APPROVE_PAYMENTS", () => expect(hasPermission(perms, "APPROVE_PAYMENTS")).toBe(false));
});

describe("formatPermissions", () => {
  it("전부 있으면 VAP", () => {
    expect(
      formatPermissions({ viewStudents: true, approveOrders: true, approvePayments: true }),
    ).toBe("VAP");
  });
  it("전부 없으면 ---", () => {
    expect(
      formatPermissions({ viewStudents: false, approveOrders: false, approvePayments: false }),
    ).toBe("---");
  });
  it("일부만 있으면 해당 자리만 글자, 나머지는 -", () => {
    expect(
      formatPermissions({ viewStudents: true, approveOrders: false, approvePayments: true }),
    ).toBe("V-P");
  });
});

describe("canAccessAdminRoute", () => {
  const noPerm = { viewStudents: false, approveOrders: false, approvePayments: false };
  const viewOnly = { viewStudents: true, approveOrders: false, approvePayments: false };
  const allPerm = { viewStudents: true, approveOrders: true, approvePayments: true };

  it("ADMIN은 어떤 경로든 접근 가능", () => {
    expect(canAccessAdminRoute("ADMIN", noPerm, "/admin/managers")).toBe(true);
    expect(canAccessAdminRoute("ADMIN", noPerm, "/admin/students")).toBe(true);
  });

  it("STUDENT는 어떤 /admin 경로도 접근 불가", () => {
    expect(canAccessAdminRoute("STUDENT", allPerm, "/admin/students")).toBe(false);
  });

  it("대시보드(/admin)는 매니저면 권한 무관 접근 가능(명시적으로 permission: [] 등록됨)", () => {
    expect(canAccessAdminRoute("MANAGER", noPerm, "/admin")).toBe(true);
  });

  it("표에 없는 /admin 경로는 기본 거부(fail-closed) — 새 관리자 화면 등록을 잊으면 조용히 막혀야지 뚫리면 안 된다", () => {
    expect(canAccessAdminRoute("MANAGER", allPerm, "/admin/this-route-does-not-exist")).toBe(false);
  });

  it("ADMIN 전용 경로는 권한이 있어도 MANAGER는 접근 불가", () => {
    expect(canAccessAdminRoute("MANAGER", allPerm, "/admin/managers")).toBe(false);
    expect(canAccessAdminRoute("MANAGER", allPerm, "/admin/courses")).toBe(false);
  });

  it("시스템 봉쇄 화면(/admin/system)은 ADMIN 전용이다 — 매니저가 스스로 봉쇄를 해제하는 구멍을 막는다", () => {
    expect(canAccessAdminRoute("ADMIN", noPerm, "/admin/system")).toBe(true);
    expect(canAccessAdminRoute("MANAGER", allPerm, "/admin/system")).toBe(false);
  });

  it("VIEW_STUDENTS 권한 매니저는 /admin/students, /admin/orders 접근 가능", () => {
    expect(canAccessAdminRoute("MANAGER", viewOnly, "/admin/students")).toBe(true);
    expect(canAccessAdminRoute("MANAGER", viewOnly, "/admin/orders")).toBe(true);
  });

  it("권한 없는 매니저는 /admin/students 접근 불가", () => {
    expect(canAccessAdminRoute("MANAGER", noPerm, "/admin/students")).toBe(false);
  });

  it("하위 경로(/admin/orders/123)도 접두어로 매칭된다", () => {
    expect(canAccessAdminRoute("MANAGER", viewOnly, "/admin/orders/123")).toBe(true);
  });
});

// ADMIN_ROUTES가 fail-closed로 바뀌면서(2026-09-27), 새 관리자 페이지를 만들고 등록을 잊으면
// "조용히 열림"이 아니라 "조용히 막힘"이 된다 — 그 등록 누락을 사람이 알아채도록 잡는 가드
// 테스트. module-map.ts의 경계 가드 테스트(lib/architecture/boundaries.guard.test.ts)와 같은
// 사상: 파일 시스템을 실제로 스캔해 표와 대조한다.
describe("ADMIN_ROUTES 등록 완전성", () => {
  it("app/admin 아래 모든 page.tsx 경로가 ADMIN_ROUTES(또는 그 접두어)로 커버된다", () => {
    const appRoot = join(process.cwd(), "app");
    const adminDir = join(appRoot, "admin");

    function collectPagePaths(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          out.push(...collectPagePaths(full));
        } else if (entry === "page.tsx") {
          out.push(`/${relative(appRoot, dir).replace(/\\/g, "/")}`);
        }
      }
      return out;
    }

    const pagePaths = collectPagePaths(adminDir);
    // 이 목록 자체가 비어 있으면(예: app 폴더 구조가 바뀜) 검사가 통과한 게 아니라 무력화된
    // 것이므로, 최소 한 개는 있어야 한다는 걸 먼저 확인한다.
    expect(pagePaths.length).toBeGreaterThan(0);

    const unregistered = pagePaths.filter((path) => !findAdminRoute(path));
    expect(unregistered).toEqual([]);
  });

  // 역방향 — 표에만 있고 page.tsx가 없으면(2026-09-27 /admin/managers 404 재발) 메뉴 링크가
  // 404가 된다. 위 테스트(페이지→표)만으로는 이 방향을 못 잡는다.
  it("ADMIN_ROUTES의 각 정적 경로(/admin 제외)에 app{path}/page.tsx가 존재한다", () => {
    const appRoot = join(process.cwd(), "app");
    const missing = ADMIN_ROUTES
      .filter((r) => r.path !== "/admin")
      .filter((r) => !existsSync(join(appRoot, ...r.path.slice(1).split("/"), "page.tsx")))
      .map((r) => r.path);
    expect(missing).toEqual([]);
  });
});

describe("adminOnlyRoutePaths", () => {
  it("조회의 who가 ADMIN인 경로만 반환한다 — /admin/system 등 ADMIN 전용 화면 전부 포함", () => {
    const paths = adminOnlyRoutePaths();
    expect(paths).toContain("/admin/system");
    expect(paths).not.toContain("/admin");
    expect(paths).not.toContain("/admin/students");
    expect(new Set(paths)).toEqual(
      new Set(ADMIN_ROUTES.filter((r) => commandDef(r.view).who === "ADMIN").map((r) => r.path)),
    );
  });
});

// 명령 레일 CR-5 — 경로별 권한은 등록부 who가 유일한 원본이다. 옛 ADMIN_ROUTES 표(permission 필드)와 결과가 같아야 한다.
describe("ADMIN_ROUTES는 등록부 who를 따른다", () => {
  it("모든 경로의 view는 등록부의 조회(QUERY)다", () => {
    const notQuery = ADMIN_ROUTES.filter((r) => commandDef(r.view).kind !== "QUERY").map((r) => r.path);
    expect(notQuery).toEqual([]);
  });

  it("경로별 who가 옛 표(permission: null / [] / 목록)와 같다", () => {
    const whoByPath = Object.fromEntries(ADMIN_ROUTES.map((r) => [r.path, commandDef(r.view).who]));
    const studentData = { anyPermission: ["VIEW_STUDENTS", "APPROVE_ORDERS"] };
    expect(whoByPath).toEqual({
      "/admin": "STAFF",
      "/admin/students": studentData,
      "/admin/orders": studentData,
      "/admin/courses": "ADMIN",
      "/admin/course-offerings": "ADMIN",
      "/admin/discount-rules": "ADMIN",
      "/admin/terms": "ADMIN",
      "/admin/payments": "ADMIN",
      "/admin/dlq": "ADMIN",
      "/admin/audit-logs": "ADMIN",
      "/admin/managers": "ADMIN",
      "/admin/system": "ADMIN",
    });
  });
});

describe("whoDenial — 등록부 who 한 값의 판정(레일과 /admin 경로 판정이 공유)", () => {
  const none = { viewStudents: false, approveOrders: false, approvePayments: false };
  const viewOnly = { viewStudents: true, approveOrders: false, approvePayments: false };
  const student = { role: "STUDENT" as const, permissions: none, withdrawnAt: null };
  const manager = { role: "MANAGER" as const, permissions: viewOnly, withdrawnAt: null };
  const admin = { role: "ADMIN" as const, permissions: { viewStudents: true, approveOrders: true, approvePayments: true }, withdrawnAt: null };
  const withdrawn = { ...student, withdrawnAt: "2026-10-01T00:00:00Z" };

  it("PUBLIC은 신원이 없어도 통과한다", () => {
    expect(whoDenial("PUBLIC", null)).toBeNull();
  });

  it("신원이 없으면 PUBLIC 외에는 로그인 안내로 거부한다", () => {
    expect(whoDenial("ACTIVE", null)).toBe("로그인이 필요합니다.");
    expect(whoDenial("WITHDRAWN", null)).toBe("로그인이 필요합니다.");
  });

  it("탈퇴 계정은 WITHDRAWN만 통과하고 나머지는 탈퇴 안내로 거부한다", () => {
    expect(whoDenial("WITHDRAWN", withdrawn)).toBeNull();
    expect(whoDenial("ACTIVE", withdrawn)).toBe("탈퇴한 계정입니다.");
    expect(whoDenial("ADMIN", withdrawn)).toBe("탈퇴한 계정입니다.");
    expect(whoDenial("WITHDRAWN", student)).toBe("탈퇴한 계정이 아닙니다.");
  });

  it("ADMIN은 관리자만, STAFF는 관리자·매니저만 통과한다", () => {
    expect(whoDenial("ADMIN", admin)).toBeNull();
    expect(whoDenial("ADMIN", manager)).toBe("관리자만 수행할 수 있습니다.");
    expect(whoDenial("STAFF", manager)).toBeNull();
    expect(whoDenial("STAFF", student)).toBe("관리자 또는 매니저만 수행할 수 있습니다.");
  });

  it("anyPermission은 그중 하나라도 있으면 통과하고 ADMIN은 항상 통과한다", () => {
    const rule = { anyPermission: ["VIEW_STUDENTS", "APPROVE_ORDERS"] } as const;
    expect(whoDenial(rule, manager)).toBeNull();
    expect(whoDenial(rule, { ...manager, permissions: none })).toBe("이 작업을 수행할 권한이 없습니다.");
    expect(whoDenial(rule, admin)).toBeNull();
    expect(whoDenial(rule, student)).toBe("관리자 또는 매니저만 수행할 수 있습니다.");
  });
});
