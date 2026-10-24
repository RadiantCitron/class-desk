// 매니저 권한 관련 순수 함수. DB/네트워크 접근이 전혀 없다(2026-09-18).
// 권한 판정의 실제 근거는 항상 DB의 has_permission()(supabase/migrations/
// 20260918100000_manager_permissions.sql)이다 — 여기 있는 로직은 그 계산 결과를
// 화면·라우팅에서 다루기 쉬운 형태로 옮기는 것뿐이며, 자체적으로 새 판정을 만들지 않는다.

import { commandDef, type CommandCode, type Who } from "@/lib/commands/registry";

export type Role = "ADMIN" | "MANAGER" | "STUDENT";

export type Permission = "VIEW_STUDENTS" | "APPROVE_ORDERS" | "APPROVE_PAYMENTS";

export type Permissions = {
  viewStudents: boolean;
  approveOrders: boolean;
  approvePayments: boolean;
};

const NO_PERMISSIONS: Permissions = {
  viewStudents: false,
  approveOrders: false,
  approvePayments: false,
};

const ALL_PERMISSIONS: Permissions = {
  viewStudents: true,
  approveOrders: true,
  approvePayments: true,
};

// manager_permissions 행 하나를 Permissions로 바꾼다. 행이 없거나(아직 한 번도 매니저였던
// 적 없음) revoked_at이 있으면(박탈됨) 전부 false다 — DB의 has_permission()과 동일한 판단
// 기준(role=MANAGER and revoked_at is null and 해당 칼럼=true)을 TS 쪽에서 그대로 반복한다.
export function resolvePermissions(
  role: Role,
  row: {
    canViewStudents: boolean;
    canApproveOrders: boolean;
    canApprovePayments: boolean;
    revokedAt: string | null;
  } | null,
): Permissions {
  if (role === "ADMIN") return ALL_PERMISSIONS;
  if (role !== "MANAGER" || !row || row.revokedAt) return NO_PERMISSIONS;

  return {
    viewStudents: row.canViewStudents,
    approveOrders: row.canApproveOrders,
    approvePayments: row.canApprovePayments,
  };
}

export function hasPermission(permissions: Permissions, permission: Permission): boolean {
  switch (permission) {
    case "VIEW_STUDENTS":
      return permissions.viewStudents;
    case "APPROVE_ORDERS":
      return permissions.approveOrders;
    case "APPROVE_PAYMENTS":
      return permissions.approvePayments;
  }
}

// 관리자 화면 목록에서 "V A P" 형태로 보여줄 때 쓴다. 리눅스 rwx 표기를 본뜬 것(사용자 지정,
// 2026-09-18) — 권한이 있으면 그 글자, 없으면 '-'.
export function formatPermissions(permissions: Permissions): string {
  return (
    (permissions.viewStudents ? "V" : "-") +
    (permissions.approveOrders ? "A" : "-") +
    (permissions.approvePayments ? "P" : "-")
  );
}

// 명령·조회 등록부(lib/commands/registry.ts)의 who 한 값을 이 사람에게 적용한 판정 — 거부 문구를 돌려주고 통과면 null이다.
// 이 판정은 레일(lib/commands/rail.ts의 who 체크)과 /admin 경로 판정(아래 canAccessAdminRoute)이 같이 쓴다 — 같은 규칙이
// 두 벌 생기지 않게. null = 신원 전(로그인·가입 전). 문구는 옛 assertActive/assertAdmin/
// assertStaff/assertPermission(lib/guards/actor.ts)·app/reactivate/actions.ts의 것과 한 글자도 다르지 않다.
export type WhoActor = { role: Role; permissions: Permissions; withdrawnAt: string | null } | null;

export function whoDenial(who: Who, actor: WhoActor): string | null {
  if (who === "PUBLIC") return null;
  if (!actor) return "로그인이 필요합니다.";
  if (who === "WITHDRAWN") return actor.withdrawnAt ? null : "탈퇴한 계정이 아닙니다.";
  if (actor.withdrawnAt) return "탈퇴한 계정입니다.";
  if (who === "ACTIVE") return null;
  if (who === "ADMIN") return actor.role === "ADMIN" ? null : "관리자만 수행할 수 있습니다.";
  if (actor.role !== "ADMIN" && actor.role !== "MANAGER") return "관리자 또는 매니저만 수행할 수 있습니다.";
  if (who === "STAFF") return null;
  return who.anyPermission.some((p) => hasPermission(actor.permissions, p)) ? null : "이 작업을 수행할 권한이 없습니다.";
}

// /admin 하위 경로별로 그 경로가 보여 주는 화면(조회) — 접근 권한은 그 조회의 등록부 who가 정한다(명령 레일 CR-5
// 권한 판정은 등록부가 유일한 원본이라 여기에 권한 목록을 따로 두지 않는다). proxy.ts(라우팅 차단)와 관리자 메뉴가 이 표 하나만
// 참조한다 — 새 관리자 화면을 추가할 때 등록부에 조회 1줄 + 여기 한 줄을 추가하면 라우팅·메뉴가 함께 갱신된다.
//
// 조회의 who가 ADMIN이면 ADMIN 전용(매니저는 권한이 있어도 못 들어간다), STAFF면 매니저면 누구나(권한 무관),
// anyPermission이면 그중 하나라도 있어야 한다.
//
// 표에 없는 경로는 기본적으로 거부한다(fail-closed, 2026-09-27 — 이전엔 표에 없으면 매니저도
// 허용이었는데, 이 화이트리스트의 취지 자체를 뒤집는 기본값이었다). 매니저에게 열어야 하는
// 경로는 반드시 여기 등록해야 한다 — 등록을 잊으면 "조용히 뚫림"이 아니라 "조용히 막힘"이
// 되도록 방향을 바꿨다.
export const ADMIN_ROUTES: { path: string; view: CommandCode; label: string }[] = [
  { path: "/admin", view: "ADMIN_DASHBOARD_VIEW", label: "대시보드" },
  { path: "/admin/students", view: "ADMIN_STUDENTS_VIEW", label: "수강생" },
  { path: "/admin/orders", view: "ADMIN_ORDERS_VIEW", label: "수강 신청 내역" },
  { path: "/admin/courses", view: "ADMIN_COURSES_VIEW", label: "강의" },
  { path: "/admin/course-offerings", view: "ADMIN_COURSE_OFFERINGS_VIEW", label: "개설강의" },
  { path: "/admin/discount-rules", view: "ADMIN_DISCOUNT_RULES_VIEW", label: "할인 규칙" },
  { path: "/admin/terms", view: "ADMIN_TERMS_VIEW", label: "약관" },
  { path: "/admin/payments", view: "ADMIN_PAYMENTS_VIEW", label: "결제 내역" },
  { path: "/admin/dlq", view: "ADMIN_DLQ_VIEW", label: "웹훅 에러(DLQ)" },
  { path: "/admin/audit-logs", view: "ADMIN_AUDIT_LOGS_VIEW", label: "관리자 조작 로그" },
  { path: "/admin/managers", view: "ADMIN_MANAGERS_VIEW", label: "매니저 관리" },
  { path: "/admin/system", view: "RAIL_SWITCH_VIEW", label: "통제 스위치" },
];

// path가 ADMIN_ROUTES의 어느 항목과 매칭되는지 찾는다(접두어 일치 — /admin/orders/123도
// /admin/orders 항목에 매칭). "/admin"(대시보드)만은 예외로 정확히 일치할 때만 매칭한다 —
// 접두어 규칙을 그대로 적용하면 "/admin"이 모든 /admin/* 경로의 접두어가 되어, 표에 없는
// 경로까지 전부 대시보드 규칙(누구나 허용)에 걸려 fail-closed 기본값이 무력화된다.
export function findAdminRoute(pathname: string) {
  return ADMIN_ROUTES.find((r) =>
    r.path === "/admin" ? pathname === r.path : pathname === r.path || pathname.startsWith(r.path + "/"),
  );
}

// ADMIN 전용(조회의 who가 ADMIN) 경로 목록 — vitest·e2e가 ADMIN_ROUTES와 같은 정본만 쓰도록
// 노출한다(2026-09-27 라우팅 조사 후속 — e2e/manager-access.spec.ts의 중복 하드코딩 표 제거).
export function adminOnlyRoutePaths(): string[] {
  return ADMIN_ROUTES.filter((r) => commandDef(r.view).who === "ADMIN").map((r) => r.path);
}

// role과 permissions만으로 pathname 접근 가능 여부를 판정한다. proxy.ts와 페이지 가드가
// 공유하는 단일 판정 지점.
export function canAccessAdminRoute(role: Role, permissions: Permissions, pathname: string): boolean {
  if (role === "ADMIN") return true;
  if (role !== "MANAGER") return false;

  const route = findAdminRoute(pathname);
  if (!route) return false; // 표에 없는 /admin/* 경로는 기본 거부(fail-closed).
  return whoDenial(commandDef(route.view).who, { role, permissions, withdrawnAt: null }) === null;
}
