import { describe, it, expect } from "vitest";
import { MODULE_LABELS } from "@/lib/architecture/module-map";
import { ALL_COMMANDS } from "./registry";
import { isKnownSwitchTarget, parseSwitchKey, switchOptions, switchTargetLabel } from "./switch-input";

// 스위치 관리 화면의 입력 검증·표시 이름. DB는 target이 등록부에 있는지 모르므로(공리·모듈 값만 안다)
// 설정 명령이 이 검증으로 막는다.
describe("parseSwitchKey — 층·대상 검증", () => {
  it("SYSTEM은 대상이 없다(넘어온 대상은 무시한다)", () => {
    expect(parseSwitchKey("SYSTEM", "")).toEqual({ level: "SYSTEM", target: null });
    expect(parseSwitchKey("SYSTEM", "PAYMENT")).toEqual({ level: "SYSTEM", target: null });
  });

  it("MODULE은 모듈 5개 중 하나만 받는다", () => {
    expect(parseSwitchKey("MODULE", "PAYMENT")).toEqual({ level: "MODULE", target: "PAYMENT" });
    expect(() => parseSwitchKey("MODULE", "PAY")).toThrow("알 수 없는 모듈입니다.");
    expect(() => parseSwitchKey("MODULE", "")).toThrow("대상을 골라 주세요.");
  });

  it("COMMAND는 등록부에 있는 명령·조회만 받는다(조회도 막을 수 있다)", () => {
    expect(parseSwitchKey("COMMAND", "PAYMENT_REFUND_REQUEST")).toEqual({ level: "COMMAND", target: "PAYMENT_REFUND_REQUEST" });
    expect(parseSwitchKey("COMMAND", "ADMIN_AUDIT_LOGS_VIEW")).toEqual({ level: "COMMAND", target: "ADMIN_AUDIT_LOGS_VIEW" });
    expect(() => parseSwitchKey("COMMAND", "NO_SUCH_COMMAND")).toThrow("알 수 없는 명령·조회입니다.");
    expect(() => parseSwitchKey("COMMAND", "")).toThrow("대상을 골라 주세요.");
  });

  it("공리(통제실 통로) 6개는 대상으로 받지 않는다 — 막으면 아무도 되돌릴 수 없다", () => {
    for (const axiom of ALL_COMMANDS.filter((c) => c.axiom)) {
      expect(() => parseSwitchKey("COMMAND", axiom.code)).toThrow("통제실 통로라 막을 수 없습니다");
    }
  });

  it("알 수 없는 층은 거부한다", () => {
    expect(() => parseSwitchKey("USER", "")).toThrow("층을 골라 주세요.");
    expect(() => parseSwitchKey("", "")).toThrow("층을 골라 주세요.");
  });
});

describe("switchTargetLabel · isKnownSwitchTarget", () => {
  it("시스템 = 서비스 전체, 모듈 = 모듈 이름, 명령·조회 = 등록부 이름", () => {
    expect(switchTargetLabel("SYSTEM", null)).toBe("서비스 전체");
    expect(switchTargetLabel("MODULE", "PAYMENT")).toBe(MODULE_LABELS.PAYMENT);
    expect(switchTargetLabel("COMMAND", "ORDER_APPLY")).toBe("수강 신청");
  });

  it("등록부에 없는 옛 대상은 원문을 그대로 보이고 알 수 없는 대상으로 표시한다", () => {
    expect(switchTargetLabel("COMMAND", "LOGIN_OLD")).toBe("LOGIN_OLD");
    expect(isKnownSwitchTarget("COMMAND", "LOGIN_OLD")).toBe(false);
    expect(isKnownSwitchTarget("COMMAND", "ORDER_APPLY")).toBe(true);
    expect(isKnownSwitchTarget("MODULE", "CS")).toBe(true);
    expect(isKnownSwitchTarget("MODULE", "BILLING")).toBe(false);
    expect(isKnownSwitchTarget("SYSTEM", null)).toBe(true);
  });
});

describe("switchOptions — 화면 선택지", () => {
  const options = switchOptions();

  it("모듈 선택지는 모듈 지도의 5개다", () => {
    expect(options.modules.map((m) => m.value).sort()).toEqual(Object.keys(MODULE_LABELS).sort());
  });

  it("명령·조회 선택지는 등록부 전체에서 공리만 뺀 것이다 — 전부 parseSwitchKey를 통과한다", () => {
    const values = options.commandGroups.flatMap((g) => g.items.map((i) => i.value));
    expect(values.sort()).toEqual(ALL_COMMANDS.filter((c) => !c.axiom).map((c) => c.code as string).sort());
    for (const value of values) expect(() => parseSwitchKey("COMMAND", value)).not.toThrow();
  });

  it("명령과 조회가 구분되어 보인다", () => {
    const items = options.commandGroups.flatMap((g) => g.items);
    expect(items.find((i) => i.value === "ORDER_APPLY")?.kindLabel).toBe("명령");
    expect(items.find((i) => i.value === "STUDENT_HOME_VIEW")?.kindLabel).toBe("조회");
  });
});
