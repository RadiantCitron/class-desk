import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Profile } from "@/lib/supabase/identity";
import type { ActiveSwitch, SwitchSnapshot } from "./rail";

// runQuery()는 같은 레일 판정을 조회에 적용한다 — 맨 아래 describe.
// runCommand() 순서 고정 — 감사 ATTEMPTED → 레일(스위치·역할) → 업무 가드 → 실행 → 결과.
// 레일·가드가 막으면 실행 함수는 불리지 않고, 막힌 사실은 FAILED로 남는다.
// vi.mock은 파일 맨 위로 끌어올려지므로, 가짜 모듈이 참조할 상태는 vi.hoisted로 같이 끌어올린다.
const state = vi.hoisted(() => ({
  calls: [] as string[],
  actor: null as Profile | null,
  records: [] as { phase: string; actorProfileId?: string; targetId?: string | null; targetRef?: string | null; detail?: Record<string, unknown> }[],
  switches: { readable: true, switches: [] } as SwitchSnapshot,
}));

const actor: Profile = {
  id: "00000000-0000-0000-0000-00000000a001",
  authUserId: "00000000-0000-0000-0000-00000000b001",
  role: "STUDENT",
  discordId: "d-1",
  email: "a@example.com",
  withdrawnAt: null,
  permissions: { viewStudents: false, approveOrders: false, approvePayments: false },
  pendingTerms: [],
};

// (가짜 신원은 state.actor — 각 테스트 전에 beforeEach가 채운다)

vi.mock("@/lib/supabase/identity", () => ({
  getCurrentProfile: async () => state.actor,
}));

vi.mock("@/lib/audit", () => ({
  getAuditSink: async () => ({ name: "test", write: async () => {} }),
  recordAudit: async (record: {
    phase: string;
    actorProfileId?: string;
    targetId?: string | null;
    targetRef?: string | null;
    detail?: Record<string, unknown>;
  }) => {
    state.calls.push(
      `audit:${record.phase}${record.detail?.guard_denied ? ":guard" : ""}${record.detail?.rail_denied ? ":rail" : ""}`,
    );
    state.records.push({ phase: record.phase, actorProfileId: record.actorProfileId, targetId: record.targetId, targetRef: record.targetRef, detail: record.detail });
  },
}));

// 통제 스위치 조회(service_role DB)를 목으로 바꾼다 — 각 테스트가 state.switches를 채운다.
vi.mock("./switches", () => ({
  loadRailSwitches: async () => {
    state.calls.push("rail");
    return state.switches;
  },
}));

import { runCommand, runQuery } from "./run-command";
import { commandDef } from "./registry";

describe("runCommand() — CS 명령 파이프라인 순서", () => {
  beforeEach(() => {
    state.calls.length = 0;
    state.records.length = 0;
    state.actor = actor;
    state.switches = { readable: true, switches: [] };
  });

  it("성공: ATTEMPTED → 레일 → 가드 → 실행 → SUCCEEDED", async () => {
    const result = await runCommand(
      { command: "ORDER_APPLY", targetTable: "t", guard: () => { state.calls.push("guard"); } },
      async () => { state.calls.push("run"); return { result: 42 }; },
    );
    expect(result).toBe(42);
    expect(state.calls).toEqual(["audit:ATTEMPTED", "rail", "guard", "run", "audit:SUCCEEDED"]);
  });

  it("가드 거부: ATTEMPTED → 가드 → FAILED(guard_denied), 실행 함수는 안 불림", async () => {
    await expect(
      runCommand(
        { command: "ORDER_APPLY", targetTable: "t", guard: () => { state.calls.push("guard"); throw new Error("막힘"); } },
        async () => { state.calls.push("run"); return { result: null }; },
      ),
    ).rejects.toThrow("막힘");
    expect(state.calls).toEqual(["audit:ATTEMPTED", "rail", "guard", "audit:FAILED:guard"]);
  });

  it("실행 실패: ATTEMPTED → 가드 → 실행 → FAILED", async () => {
    await expect(
      runCommand(
        { command: "ORDER_APPLY", targetTable: "t", guard: () => {} },
        async () => { state.calls.push("run"); throw new Error("실행 실패"); },
      ),
    ).rejects.toThrow("실행 실패");
    expect(state.calls).toEqual(["audit:ATTEMPTED", "rail", "run", "audit:FAILED"]);
  });

  it("신원 없음: 아무것도 기록하지 않고 거부", async () => {
    state.actor = null;
    await expect(
      runCommand({ command: "ORDER_APPLY", targetTable: "t", guard: () => {} }, async () => ({ result: null })),
    ).rejects.toThrow("로그인이 필요합니다.");
    expect(state.calls).toEqual([]);
  });

  it("가드가 돌려준 값이 실행 함수의 두 번째 인자로 넘어간다", async () => {
    const result = await runCommand(
      { command: "ORDER_APPLY", targetTable: "t", guard: () => ({ amount: 1000 }) },
      async (_actor, guarded) => ({ result: guarded.amount }),
    );
    expect(result).toBe(1000);
  });

  // R-5(2026-10-02): 명령이 던져도 FAILED 감사 행에 대상이 남아야 한다(환불 거절 감사 target_id 누락).
  const ORDER = "11111111-1111-4111-8111-111111111111";

  it("대상 지정(target): 실행 실패 FAILED 행에도 targetId가 남는다", async () => {
    await expect(
      runCommand(
        { command: "ORDER_APPLY", targetTable: "t", target: { targetId: ORDER }, guard: () => {} },
        async () => { throw new Error("환불할 잔액이 없습니다."); },
      ),
    ).rejects.toThrow();
    expect(state.records.map((r) => [r.phase, r.targetId])).toEqual([
      ["ATTEMPTED", ORDER],
      ["FAILED", ORDER],
    ]);
  });

  it("대상 지정(target): 가드 거부 FAILED 행에도 targetId가 남는다", async () => {
    await expect(
      runCommand(
        { command: "ORDER_APPLY", targetTable: "t", target: { targetId: ORDER }, guard: () => { throw new Error("막힘"); } },
        async () => ({ result: null }),
      ),
    ).rejects.toThrow("막힘");
    expect(state.records.map((r) => [r.phase, r.targetId])).toEqual([
      ["ATTEMPTED", ORDER],
      ["FAILED", ORDER],
    ]);
  });

  it("대상 지정(target): SUCCEEDED는 fn이 돌려준 targetId가 있으면 그것을, 없으면 지정값을 쓴다", async () => {
    await runCommand(
      { command: "ORDER_APPLY", targetTable: "t", target: { targetId: ORDER }, guard: () => {} },
      async () => ({ result: 1, targetId: "22222222-2222-4222-8222-222222222222" }),
    );
    await runCommand(
      { command: "ORDER_APPLY", targetTable: "t", target: { targetId: ORDER }, guard: () => {} },
      async () => ({ result: 2 }),
    );
    const succeeded = state.records.filter((r) => r.phase === "SUCCEEDED").map((r) => r.targetId);
    expect(succeeded).toEqual(["22222222-2222-4222-8222-222222222222", ORDER]);
  });

  it("대상 미지정(기존 호출): 동작 불변 — FAILED 행에 targetId가 없다", async () => {
    await expect(
      runCommand({ command: "ORDER_APPLY", targetTable: "t", guard: () => {} }, async () => { throw new Error("x"); }),
    ).rejects.toThrow();
    expect(state.records.every((r) => r.targetId == null)).toBe(true);
  });
});

describe("runCommand() — 레일(통제 스위치·역할)", () => {
  const admin: Profile = {
    ...actor,
    id: "00000000-0000-0000-0000-00000000ad01",
    role: "ADMIN",
    permissions: { viewStudents: true, approveOrders: true, approvePayments: true },
  };
  function sw(level: ActiveSwitch["level"], target: string | null, userId: string | null = null): ActiveSwitch {
    return { id: `sw-${level}-${target}-${userId}`, level, target, userId, reason: "점검", setAt: "2026-10-07T00:00:00Z" };
  }
  const run = (command: Parameters<typeof runCommand>[0]["command"]) =>
    runCommand({ command, targetTable: "t", guard: () => { state.calls.push("guard"); } }, async () => {
      state.calls.push("run");
      return { result: "ok" };
    });

  beforeEach(() => {
    state.calls.length = 0;
    state.records.length = 0;
    state.actor = actor;
    state.switches = { readable: true, switches: [] };
  });

  it("스위치 거부: ATTEMPTED → 레일 → FAILED(rail_denied), 가드·실행은 안 불림, 사용자 문구로 던짐", async () => {
    state.switches = { readable: true, switches: [sw("MODULE", "ORDER")] };
    await expect(run("ORDER_APPLY")).rejects.toThrow("주문 기능이 일시 중단되었습니다: 점검");
    expect(state.calls).toEqual(["audit:ATTEMPTED", "rail", "audit:FAILED:rail"]);
    expect(state.records[1].detail?.rail_denied).toEqual({ check: "SWITCH", layer: "MODULE", switchId: "sw-MODULE-ORDER-null" });
  });

  it("관리자도 SYSTEM 스위치에 막힌다(면제 없음)", async () => {
    state.actor = admin;
    state.switches = { readable: true, switches: [sw("SYSTEM", null)] };
    await expect(run("COURSE_CREATE")).rejects.toThrow("서비스가 일시 중단되었습니다: 점검");
  });

  it("공리 RAIL_SWITCH_SET은 SYSTEM 봉쇄 중에도 통과한다(봉쇄를 풀 수 있어야 한다)", async () => {
    state.actor = admin;
    state.switches = { readable: true, switches: [sw("SYSTEM", null)] };
    await expect(run("RAIL_SWITCH_SET")).resolves.toBe("ok");
  });

  it("스위치를 못 읽으면 거부(fail-closed), 공리는 통과", async () => {
    state.actor = admin;
    state.switches = { readable: false };
    await expect(run("COURSE_CREATE")).rejects.toThrow("이용 제한 상태를 확인할 수 없어");
    await expect(run("RAIL_SWITCH_SET")).resolves.toBe("ok");
  });

  it("역할(who) 거부: 학생이 관리자 명령 — 기존 assertAdmin과 같은 문구", async () => {
    await expect(run("COURSE_CREATE")).rejects.toThrow("관리자만 수행할 수 있습니다.");
    expect(state.calls).toEqual(["audit:ATTEMPTED", "rail", "audit:FAILED:rail"]);
  });

  it("유저 대상 스위치는 그 유저만 막는다", async () => {
    state.switches = { readable: true, switches: [sw("COMMAND", "ORDER_APPLY", "someone-else")] };
    await expect(run("ORDER_APPLY")).resolves.toBe("ok");
    state.switches = { readable: true, switches: [sw("COMMAND", "ORDER_APPLY", actor.id)] };
    await expect(run("ORDER_APPLY")).rejects.toThrow("관리자에 의해 수강 신청 기능이 제한되었습니다: 점검");
  });

  it("탈퇴 계정은 ACTIVE 명령을 못 하고, 계정 복구(WITHDRAWN)만 한다", async () => {
    state.actor = { ...actor, withdrawnAt: "2026-10-01T00:00:00Z" };
    await expect(run("ORDER_APPLY")).rejects.toThrow("탈퇴한 계정입니다.");
    await expect(run("ACCOUNT_REACTIVATE")).resolves.toBe("ok");
  });
});

describe("runCommand() — 신원 전 명령·신원 주입", () => {
  function sw(level: ActiveSwitch["level"], target: string | null, userId: string | null = null): ActiveSwitch {
    return { id: `sw-${level}-${target}-${userId}`, level, target, userId, reason: "점검", setAt: "2026-10-07T00:00:00Z" };
  }
  const NEW_USER = "00000000-0000-0000-0000-00000000c001";

  beforeEach(() => {
    state.calls.length = 0;
    state.records.length = 0;
    state.actor = null;
    state.switches = { readable: true, switches: [] };
  });

  it("who가 PUBLIC인 명령은 신원이 없어도 레일을 지나 실행되고, 행위자가 없어 기록은 없다", async () => {
    const result = await runCommand({ command: "ACCOUNT_SIGNUP", targetTable: "users" }, async (who) => ({ result: who }));
    expect(result).toBeNull();
    expect(state.calls).toEqual(["rail"]);
    expect(state.records).toEqual([]);
  });

  it("가입 봉쇄(스위치)는 신원이 없어도 막는다 — 사유가 사용자 문구로 나가고 기록은 없다", async () => {
    state.switches = { readable: true, switches: [sw("COMMAND", "ACCOUNT_SIGNUP")] };
    await expect(
      runCommand({ command: "ACCOUNT_SIGNUP", targetTable: "users" }, async () => { state.calls.push("run"); return { result: 1 }; }),
    ).rejects.toThrow("회원가입 기능이 일시 중단되었습니다: 점검");
    expect(state.calls).toEqual(["rail"]);
    expect(state.records).toEqual([]);
  });

  it("신원이 필요한 명령은 신원이 없으면 레일 전에 거부한다(기존 동작)", async () => {
    await expect(runCommand({ command: "ORDER_APPLY", targetTable: "t" }, async () => ({ result: 1 }))).rejects.toThrow("로그인이 필요합니다.");
    expect(state.calls).toEqual([]);
  });

  it("신원 전 명령이 성공하면 결과의 actorProfileId로 SUCCEEDED 한 줄만 남긴다(가입 마무리 — 시도 행 없음)", async () => {
    await runCommand({ command: "ACCOUNT_SIGNUP", targetTable: "users" }, async () => ({
      result: 1,
      actorProfileId: NEW_USER,
      targetId: NEW_USER,
      detail: { termsIds: ["t1"] },
    }));
    expect(state.records).toEqual([
      { phase: "SUCCEEDED", actorProfileId: NEW_USER, targetId: NEW_USER, targetRef: undefined, detail: { termsIds: ["t1"] } },
    ]);
  });

  it("신원 전 명령이 실패하면 기록하지 않고 그대로 던진다", async () => {
    await expect(runCommand({ command: "ACCOUNT_SIGNUP", targetTable: "users" }, async () => { throw new Error("가입 처리 실패"); })).rejects.toThrow("가입 처리 실패");
    expect(state.records).toEqual([]);
  });

  it("identity로 신원을 넘기면 세션을 읽지 않고 그 사람으로 기록한다(route handler — 방금 확정한 세션은 쿠키로 아직 안 보인다)", async () => {
    state.actor = null; // 세션에는 아무도 없다
    await runCommand({ command: "LOGIN", targetTable: "users", identity: { actor } }, async (who) => ({ result: who?.id }));
    expect(state.records.map((r) => [r.phase, r.actorProfileId])).toEqual([
      ["ATTEMPTED", actor.id],
      ["SUCCEEDED", actor.id],
    ]);
  });

  it("로그인(LOGIN)은 시스템 봉쇄에도 통과한다(통제실 통로) — 대신 로그인 뒤의 명령이 막힌다", async () => {
    state.switches = { readable: true, switches: [sw("SYSTEM", null)] };
    await expect(runCommand({ command: "LOGIN", targetTable: "users", identity: { actor } }, async () => ({ result: "ok" }))).resolves.toBe("ok");
    await expect(runCommand({ command: "ORDER_APPLY", targetTable: "t", identity: { actor } }, async () => ({ result: "ok" }))).rejects.toThrow("서비스가 일시 중단되었습니다: 점검");
  });

  it("로그아웃(LOGOUT)은 등록부 기본값(FULL)대로 시도·성공이 남는다 — 예전 signOut은 기록이 없었다", async () => {
    state.actor = actor;
    await runCommand({ command: "LOGOUT", targetTable: "users" }, async () => ({ result: undefined }));
    expect(state.records.map((r) => r.phase)).toEqual(["ATTEMPTED", "SUCCEEDED"]);
  });
});

describe("runQuery() — 조회 레일", () => {
  const admin: Profile = {
    ...actor,
    id: "00000000-0000-0000-0000-00000000ad01",
    role: "ADMIN",
    permissions: { viewStudents: true, approveOrders: true, approvePayments: true },
  };
  function sw(level: ActiveSwitch["level"], target: string | null, userId: string | null = null): ActiveSwitch {
    return { id: `sw-${level}-${target}-${userId}`, level, target, userId, reason: "점검", setAt: "2026-10-07T00:00:00Z" };
  }
  const read = async () => {
    state.calls.push("read");
    return "화면값";
  };

  beforeEach(() => {
    state.calls.length = 0;
    state.records.length = 0;
    state.actor = actor;
    state.switches = { readable: true, switches: [] };
  });

  it("통과: 레일 → 실행. 조회의 기본은 기록 OFF라 감사 기록이 하나도 없다", async () => {
    await expect(runQuery({ command: "STUDENT_HOME_VIEW" }, read)).resolves.toBe("화면값");
    expect(state.calls).toEqual(["rail", "read"]);
    expect(state.records).toEqual([]);
  });

  it("실행 함수는 신원(Profile)을 받는다", async () => {
    await expect(runQuery({ command: "STUDENT_HOME_VIEW" }, async (who) => who.id)).resolves.toBe(actor.id);
  });

  it("스위치 거부: 실행 안 함, 사용자 문구로 던지고, 거부는 기록 OFF여도 FAILED로 남는다(시도 행 없음)", async () => {
    state.switches = { readable: true, switches: [sw("MODULE", "ORDER")] };
    await expect(runQuery({ command: "STUDENT_HOME_VIEW" }, read)).rejects.toThrow("주문 기능이 일시 중단되었습니다: 점검");
    expect(state.calls).toEqual(["rail", "audit:FAILED:rail"]);
    expect(state.records[0].detail?.rail_denied).toEqual({ check: "SWITCH", layer: "MODULE", switchId: "sw-MODULE-ORDER-null" });
  });

  it("조회 이름 단위로도 막는다 — 감사 로그 화면만 끄면 다른 화면은 열린다", async () => {
    state.actor = admin;
    state.switches = { readable: true, switches: [sw("COMMAND", "ADMIN_AUDIT_LOGS_VIEW")] };
    await expect(runQuery({ command: "ADMIN_AUDIT_LOGS_VIEW" }, read)).rejects.toThrow("감사 로그 화면 기능이 일시 중단되었습니다");
    await expect(runQuery({ command: "ADMIN_DLQ_VIEW" }, read)).resolves.toBe("화면값");
  });

  it("유저 대상 스위치는 그 유저의 조회만 막는다(옛 학생 VIEW 제한)", async () => {
    state.switches = { readable: true, switches: [sw("COMMAND", "STUDENT_HOME_VIEW", "someone-else")] };
    await expect(runQuery({ command: "STUDENT_HOME_VIEW" }, read)).resolves.toBe("화면값");
    state.switches = { readable: true, switches: [sw("COMMAND", "STUDENT_HOME_VIEW", actor.id)] };
    await expect(runQuery({ command: "STUDENT_HOME_VIEW" }, read)).rejects.toThrow("관리자에 의해 학생 홈 화면 기능이 제한되었습니다: 점검");
  });

  it("관리자도 SYSTEM 스위치에 막힌다(면제 없음)", async () => {
    state.actor = admin;
    state.switches = { readable: true, switches: [sw("SYSTEM", null)] };
    await expect(runQuery({ command: "ADMIN_COURSES_VIEW" }, read)).rejects.toThrow("서비스가 일시 중단되었습니다: 점검");
  });

  it("역할(who) 거부: 학생이 관리자 화면 — 기존 requireAdminProfile과 같은 문구", async () => {
    await expect(runQuery({ command: "ADMIN_COURSES_VIEW" }, read)).rejects.toThrow("관리자만 수행할 수 있습니다.");
    expect(state.calls).toEqual(["rail", "audit:FAILED:rail"]);
  });

  it("anyPermission 조회: 권한 없는 매니저는 거부, 권한 있는 매니저·관리자는 통과", async () => {
    const manager: Profile = { ...actor, role: "MANAGER", permissions: { viewStudents: false, approveOrders: false, approvePayments: true } };
    state.actor = manager;
    await expect(runQuery({ command: "ADMIN_STUDENTS_VIEW" }, read)).rejects.toThrow("이 작업을 수행할 권한이 없습니다.");
    state.actor = { ...manager, permissions: { ...manager.permissions, viewStudents: true } };
    await expect(runQuery({ command: "ADMIN_STUDENTS_VIEW" }, read)).resolves.toBe("화면값");
    state.actor = admin;
    await expect(runQuery({ command: "ADMIN_STUDENTS_VIEW" }, read)).resolves.toBe("화면값");
  });

  it("onDenied: 거부되면 예외 대신 그 값을 돌려주고, 거부 기록은 남는다", async () => {
    state.switches = { readable: true, switches: [sw("SYSTEM", null)] };
    const result = await runQuery(
      { command: "STUDENT_HOME_VIEW", onDenied: (denial) => `제한: ${denial.message}` },
      read,
    );
    expect(result).toBe("제한: 서비스가 일시 중단되었습니다: 점검");
    expect(state.calls).toEqual(["rail", "audit:FAILED:rail"]);
  });

  it("통로(공리) 조회 RAIL_SWITCH_VIEW는 SYSTEM 봉쇄·스위치 조회 실패에도 열린다(역할은 본다)", async () => {
    state.actor = admin;
    state.switches = { readable: true, switches: [sw("SYSTEM", null)] };
    await expect(runQuery({ command: "RAIL_SWITCH_VIEW" }, read)).resolves.toBe("화면값");
    state.switches = { readable: false };
    await expect(runQuery({ command: "RAIL_SWITCH_VIEW" }, read)).resolves.toBe("화면값");
    state.actor = actor;
    await expect(runQuery({ command: "RAIL_SWITCH_VIEW" }, read)).rejects.toThrow("관리자만 수행할 수 있습니다.");
  });

  it("스위치를 못 읽으면 통로 밖 조회는 거부(fail-closed)", async () => {
    state.switches = { readable: false };
    await expect(runQuery({ command: "STUDENT_HOME_VIEW" }, read)).rejects.toThrow("이용 제한 상태를 확인할 수 없어");
  });

  it("신원 없이 열리는 조회(PUBLIC)는 actor가 null이어도 통과한다", async () => {
    state.actor = null;
    await expect(runQuery({ command: "SIGNUP_VIEW" }, async (who) => who)).resolves.toBeNull();
  });

  it("신원 없음 + 신원이 필요한 조회: 로그인 안내로 거부, 행위자가 없어 기록은 못 남긴다", async () => {
    state.actor = null;
    await expect(runQuery({ command: "STUDENT_HOME_VIEW" }, read)).rejects.toThrow("로그인이 필요합니다.");
    expect(state.records).toEqual([]);
  });

  it("신원 없음 + 전원 대상 스위치: PUBLIC 조회도 막히고 기록은 남기지 않는다", async () => {
    state.actor = null;
    state.switches = { readable: true, switches: [sw("COMMAND", "SIGNUP_VIEW")] };
    await expect(runQuery({ command: "SIGNUP_VIEW" }, read)).rejects.toThrow("가입 화면 기능이 일시 중단되었습니다: 점검");
    expect(state.records).toEqual([]);
  });

  it("명령(COMMAND)은 runQuery로 실행할 수 없다", async () => {
    await expect(runQuery({ command: "ORDER_APPLY" as never }, read)).rejects.toThrow("runQuery는 조회만 실행한다");
  });

  it("실행 함수의 실패는 기록 OFF면 그대로 던지고 아무것도 남기지 않는다", async () => {
    await expect(runQuery({ command: "STUDENT_HOME_VIEW" }, async () => { throw new Error("DB 오류"); })).rejects.toThrow("DB 오류");
    expect(state.records).toEqual([]);
  });

  describe("등록부에서 audit: FULL로 켠 조회(나중의 열람 기록 요구 — 코드 변경 없이 등록부 한 줄)", () => {
    const def = commandDef("ADMIN_STUDENT_DETAIL_VIEW");
    const original = def.audit;
    beforeEach(() => { def.audit = "FULL"; state.actor = admin; });
    afterEach(() => { def.audit = original; });

    it("ATTEMPTED → 레일 → 실행 → SUCCEEDED", async () => {
      await expect(runQuery({ command: "ADMIN_STUDENT_DETAIL_VIEW" }, read)).resolves.toBe("화면값");
      expect(state.calls).toEqual(["audit:ATTEMPTED", "rail", "read", "audit:SUCCEEDED"]);
    });

    it("실행 실패는 FAILED로 남기되, redirect·notFound 같은 Next.js 제어 흐름은 실패로 기록하지 않는다", async () => {
      await expect(runQuery({ command: "ADMIN_STUDENT_DETAIL_VIEW" }, async () => { throw new Error("DB 오류"); })).rejects.toThrow("DB 오류");
      expect(state.calls).toEqual(["audit:ATTEMPTED", "rail", "audit:FAILED"]);

      state.calls.length = 0;
      const redirectLike = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/student;307;" });
      await expect(runQuery({ command: "ADMIN_STUDENT_DETAIL_VIEW" }, async () => { throw redirectLike; })).rejects.toBe(redirectLike);
      expect(state.calls).toEqual(["audit:ATTEMPTED", "rail"]);
    });
  });
});
