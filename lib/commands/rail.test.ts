import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { MODULE_LABELS, type ModuleName } from "@/lib/architecture/module-map";
import { ALL_COMMANDS, COMMANDS_BY_MODULE, commandDef, isCommandCode } from "./registry";
import { railVerdict, type ActiveSwitch, type RailActor, type SwitchSnapshot } from "./rail";

// 명령 레일 CR-1 — 등록부 정합성과 판정(시스템 → 모듈 → 명령, 각 층 전원/본인, 역할) 고정.
// 아직 아무 코드도 레일을 부르지 않는다(CR-3부터 연결).

const ALL_PERMS = { viewStudents: true, approveOrders: true, approvePayments: true };
const NO_PERMS = { viewStudents: false, approveOrders: false, approvePayments: false };

const student: RailActor = { id: "u-student", role: "STUDENT", permissions: NO_PERMS, withdrawnAt: null };
const otherStudent: RailActor = { id: "u-other", role: "STUDENT", permissions: NO_PERMS, withdrawnAt: null };
const admin: RailActor = { id: "u-admin", role: "ADMIN", permissions: ALL_PERMS, withdrawnAt: null };
const managerApprover: RailActor = {
  id: "u-mgr",
  role: "MANAGER",
  permissions: { viewStudents: false, approveOrders: true, approvePayments: false },
  withdrawnAt: null,
};
const managerNone: RailActor = { id: "u-mgr2", role: "MANAGER", permissions: NO_PERMS, withdrawnAt: null };
const withdrawn: RailActor = { id: "u-gone", role: "STUDENT", permissions: NO_PERMS, withdrawnAt: "2026-10-01T00:00:00Z" };

let seq = 0;
function sw(level: ActiveSwitch["level"], target: string | null, userId: string | null = null): ActiveSwitch {
  seq += 1;
  return { id: `sw-${seq}`, level, target, userId, reason: "점검", setAt: "2026-10-07T00:00:00Z" };
}
function on(...switches: ActiveSwitch[]): SwitchSnapshot {
  return { readable: true, switches };
}
const NONE = on();
const UNREADABLE: SwitchSnapshot = { readable: false };

describe("등록부", () => {
  it("모든 모듈 칸이 있고 이름은 모듈을 넘어 유일하다", () => {
    expect(Object.keys(COMMANDS_BY_MODULE).sort()).toEqual((Object.keys(MODULE_LABELS) as ModuleName[]).sort());
    const codes = ALL_COMMANDS.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("공리(통제실 통로)는 정확히 이 6개다 — 늘리면 이 테스트를 사용자와 다시 정한다", () => {
    expect(ALL_COMMANDS.filter((c) => c.axiom).map((c) => c.code).sort()).toEqual(
      ["ADMIN_SHELL_VIEW", "LOGIN", "LOGIN_VIEW", "LOGOUT", "RAIL_SWITCH_SET", "RAIL_SWITCH_VIEW"],
    );
  });

  it("기록 기본값: 명령 = FULL, 조회 = OFF", () => {
    for (const c of ALL_COMMANDS) {
      expect(c.audit).toBe(c.kind === "COMMAND" ? "FULL" : "OFF");
    }
  });

  it("모든 항목에 한국어 이름이 있다", () => {
    for (const c of ALL_COMMANDS) expect(c.label.trim().length).toBeGreaterThan(0);
  });

  it("조회는 화면 로더 30개다(ui/views — 게이트 배너 제외, A-3 ADMIN_BULK_REFUND_PREVIEW 포함)", () => {
    expect(ALL_COMMANDS.filter((c) => c.kind === "QUERY")).toHaveLength(30);
  });

  // 코드에 쓰인 이름 ↔ 등록부, 등록부의 모든 명령이 쓰이는가, 신고·실제 대조는 rail.guard.test.ts가 맡는다.
});

describe("레일 판정 — 스위치(시스템 → 모듈 → 명령)", () => {
  it("스위치가 없으면 통과", () => {
    expect(railVerdict("ORDER_APPLY", student, NONE)).toEqual({ ok: true });
  });

  it("SYSTEM(전원): 학생·관리자 모두 거부, 공리만 통과", () => {
    const s = on(sw("SYSTEM", null));
    expect(railVerdict("ORDER_APPLY", student, s)).toMatchObject({ ok: false, check: "SWITCH", layer: "SYSTEM" });
    expect(railVerdict("COURSE_CREATE", admin, s)).toMatchObject({ ok: false, layer: "SYSTEM" });
    expect(railVerdict("ADMIN_AUDIT_LOGS_VIEW", admin, s)).toMatchObject({ ok: false, layer: "SYSTEM" });
    expect(railVerdict("RAIL_SWITCH_VIEW", admin, s)).toEqual({ ok: true });
    expect(railVerdict("RAIL_SWITCH_SET", admin, s)).toEqual({ ok: true });
    expect(railVerdict("ADMIN_SHELL_VIEW", admin, s)).toEqual({ ok: true });
    expect(railVerdict("LOGIN", null, s)).toEqual({ ok: true });
    expect(railVerdict("LOGIN_VIEW", null, s)).toEqual({ ok: true });
    expect(railVerdict("LOGOUT", student, s)).toEqual({ ok: true });
  });

  it("공리도 역할 검사는 받는다 — 학생은 SYSTEM 봉쇄와 무관하게 스위치를 못 바꾼다", () => {
    expect(railVerdict("RAIL_SWITCH_SET", student, on(sw("SYSTEM", null)))).toMatchObject({ ok: false, check: "WHO" });
  });

  it("MODULE ORDER: 신청·과목 생성·주문 조회 거부, 결제는 통과", () => {
    const s = on(sw("MODULE", "ORDER"));
    expect(railVerdict("ORDER_APPLY", student, s)).toMatchObject({ ok: false, layer: "MODULE" });
    expect(railVerdict("COURSE_CREATE", admin, s)).toMatchObject({ ok: false, layer: "MODULE" });
    expect(railVerdict("STUDENT_HOME_VIEW", student, s)).toMatchObject({ ok: false, layer: "MODULE" });
    expect(railVerdict("PAYMENT_START", student, s)).toEqual({ ok: true });
  });

  it("MODULE PAYMENT: 결제 시작·확정 거부, 신청 통과", () => {
    const s = on(sw("MODULE", "PAYMENT"));
    expect(railVerdict("PAYMENT_START", student, s)).toMatchObject({ ok: false, layer: "MODULE" });
    expect(railVerdict("PAYMENT_CONFIRM", student, s)).toMatchObject({ ok: false, layer: "MODULE" });
    expect(railVerdict("ORDER_APPLY", student, s)).toEqual({ ok: true });
  });

  it("COMMAND 하나만: 환불 요청만 거부, 수동 환불 반영은 통과", () => {
    const s = on(sw("COMMAND", "PAYMENT_REFUND_REQUEST"));
    expect(railVerdict("PAYMENT_REFUND_REQUEST", admin, s)).toMatchObject({ ok: false, layer: "COMMAND" });
    expect(railVerdict("PAYMENT_REFUND_MANUAL", admin, s)).toEqual({ ok: true });
  });

  it("COMMAND로 인증(디스코드 연결)·조회 하나도 끈다", () => {
    expect(railVerdict("DISCORD_LINK", student, on(sw("COMMAND", "DISCORD_LINK")))).toMatchObject({ ok: false });
    expect(railVerdict("ADMIN_AUDIT_LOGS_VIEW", admin, on(sw("COMMAND", "ADMIN_AUDIT_LOGS_VIEW")))).toMatchObject({ ok: false });
  });

  it("유저 축: 그 유저만 막힌다(학생 A의 결제만, 학생 B는 통과)", () => {
    const s = on(sw("MODULE", "PAYMENT", "u-student"));
    expect(railVerdict("PAYMENT_START", student, s)).toMatchObject({ ok: false, layer: "MODULE" });
    expect(railVerdict("PAYMENT_START", otherStudent, s)).toEqual({ ok: true });
    expect(railVerdict("ORDER_APPLY", student, s)).toEqual({ ok: true });
  });

  it("유저 축은 관리자에게도 걸린다(관리자 완전 차단 = SYSTEM + 그 관리자)", () => {
    const s = on(sw("SYSTEM", null, "u-admin"));
    expect(railVerdict("COURSE_CREATE", admin, s)).toMatchObject({ ok: false, layer: "SYSTEM" });
    expect(railVerdict("RAIL_SWITCH_SET", admin, s)).toEqual({ ok: true });
  });

  it("층 순서: 시스템이 모듈보다 먼저 판정된다", () => {
    const system = sw("SYSTEM", null);
    const verdict = railVerdict("ORDER_APPLY", student, on(sw("MODULE", "ORDER"), system));
    expect(verdict).toMatchObject({ ok: false, layer: "SYSTEM", switchId: system.id });
  });

  it("거부 문구: 전원 대상은 '일시 중단', 본인 대상은 '관리자에 의해 … 제한'", () => {
    expect(railVerdict("PAYMENT_START", student, on(sw("MODULE", "PAYMENT")))).toMatchObject({
      message: "결제 기능이 일시 중단되었습니다: 점검",
    });
    expect(railVerdict("ORDER_APPLY", student, on(sw("COMMAND", "ORDER_APPLY", "u-student")))).toMatchObject({
      message: "관리자에 의해 수강 신청 기능이 제한되었습니다: 점검",
    });
    expect(railVerdict("ORDER_APPLY", student, on(sw("SYSTEM", null)))).toMatchObject({
      message: "서비스가 일시 중단되었습니다: 점검",
    });
  });

  it("스위치를 못 읽으면 닫힘(fail-closed) — 공리만 통과", () => {
    expect(railVerdict("ORDER_APPLY", student, UNREADABLE)).toMatchObject({ ok: false, check: "SWITCHES_READABLE" });
    expect(railVerdict("ADMIN_DASHBOARD_VIEW", admin, UNREADABLE)).toMatchObject({ ok: false });
    expect(railVerdict("RAIL_SWITCH_SET", admin, UNREADABLE)).toEqual({ ok: true });
    expect(railVerdict("LOGIN", null, UNREADABLE)).toEqual({ ok: true });
  });
});

describe("레일 판정 — 역할·권한(who, 기존 가드와 같은 문구)", () => {
  it("신원 없음: PUBLIC만 통과", () => {
    expect(railVerdict("ACCOUNT_SIGNUP", null, NONE)).toEqual({ ok: true });
    expect(railVerdict("ORDER_APPLY", null, NONE)).toMatchObject({ ok: false, message: "로그인이 필요합니다." });
  });

  it("ACTIVE: 탈퇴 계정 거부", () => {
    expect(railVerdict("ORDER_APPLY", withdrawn, NONE)).toMatchObject({ ok: false, message: "탈퇴한 계정입니다." });
  });

  it("WITHDRAWN: 탈퇴 계정만 통과(계정 복구)", () => {
    expect(railVerdict("ACCOUNT_REACTIVATE", withdrawn, NONE)).toEqual({ ok: true });
    expect(railVerdict("ACCOUNT_REACTIVATE", student, NONE)).toMatchObject({ ok: false, message: "탈퇴한 계정이 아닙니다." });
  });

  it("ADMIN: 매니저·학생 거부", () => {
    expect(railVerdict("COURSE_CREATE", managerApprover, NONE)).toMatchObject({ message: "관리자만 수행할 수 있습니다." });
    expect(railVerdict("COURSE_CREATE", student, NONE)).toMatchObject({ message: "관리자만 수행할 수 있습니다." });
    expect(railVerdict("COURSE_CREATE", admin, NONE)).toEqual({ ok: true });
  });

  it("STAFF: 관리자·매니저 통과, 학생 거부", () => {
    expect(railVerdict("ADMIN_DASHBOARD_VIEW", managerNone, NONE)).toEqual({ ok: true });
    expect(railVerdict("ADMIN_DASHBOARD_VIEW", student, NONE)).toMatchObject({
      message: "관리자 또는 매니저만 수행할 수 있습니다.",
    });
  });

  it("anyPermission: 권한 있는 매니저·관리자 통과, 권한 없는 매니저 거부", () => {
    expect(railVerdict("ORDER_APPROVE", managerApprover, NONE)).toEqual({ ok: true });
    expect(railVerdict("ORDER_APPROVE", admin, NONE)).toEqual({ ok: true });
    expect(railVerdict("ORDER_APPROVE", managerNone, NONE)).toMatchObject({ message: "이 작업을 수행할 권한이 없습니다." });
    // 수강생 화면은 VIEW_STUDENTS 또는 APPROVE_ORDERS(ADMIN_ROUTES와 같은 조건)
    expect(railVerdict("ADMIN_STUDENTS_VIEW", managerApprover, NONE)).toEqual({ ok: true });
  });

  it("스위치가 역할보다 먼저 판정된다(시스템 → 모듈 → 유저권한 순서)", () => {
    expect(railVerdict("COURSE_CREATE", student, on(sw("MODULE", "ORDER")))).toMatchObject({ check: "SWITCH" });
  });
});
