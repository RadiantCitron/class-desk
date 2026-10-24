import { MODULE_LABELS, type ModuleName } from "@/lib/architecture/module-map";
import { UserFacingError } from "@/lib/errors";
import { ALL_COMMANDS, commandDef, isCommandCode } from "./registry";
import type { SwitchLevel } from "./rail";
import type { SwitchKey } from "./switches";

// 스위치 관리 화면의 입력 검증과 표시 이름. 순수 함수 — DB·세션 접근 없음.
//
// rail_switches의 target이 등록부에 있는 모듈·명령인지는 DB가 모른다(DB는 공리 6개와 모듈 5개 값만 안다).
// 쓰기 경로가 공리 명령 RAIL_SWITCH_SET 하나뿐이므로 그 실행 함수가 여기서 등록부로 검증한다.

const LEVELS: readonly SwitchLevel[] = ["SYSTEM", "MODULE", "COMMAND"];

export function isSwitchLevel(value: string): value is SwitchLevel {
  return (LEVELS as readonly string[]).includes(value);
}

// 화면에서 받은 층·대상을 검증된 스위치 키로 바꾼다. 틀리면 사용자 문구로 던진다.
export function parseSwitchKey(level: string, target: string): SwitchKey {
  if (!isSwitchLevel(level)) throw new UserFacingError("층을 골라 주세요.");
  if (level === "SYSTEM") return { level, target: null };
  if (!target) throw new UserFacingError("대상을 골라 주세요.");
  if (level === "MODULE") {
    if (!(target in MODULE_LABELS)) throw new UserFacingError("알 수 없는 모듈입니다.");
    return { level, target };
  }
  if (!isCommandCode(target)) throw new UserFacingError("알 수 없는 명령·조회입니다.");
  if (commandDef(target).axiom) {
    // 통제실 통로는 막으면 아무도 스위치를 되돌릴 수 없다 — DB 제약도 같은 이유로 거부한다.
    throw new UserFacingError("이 항목은 통제실 통로라 막을 수 없습니다. 막으면 스위치를 되돌릴 방법이 없어집니다.");
  }
  return { level, target };
}

// 표시 이름: 시스템 = 「서비스 전체」, 모듈 = 모듈 이름, 명령·조회 = 등록부 이름. 등록부에 없는 옛 대상은 원문을 그대로 보인다.
export function switchTargetLabel(level: SwitchLevel, target: string | null): string {
  if (level === "SYSTEM") return "서비스 전체";
  if (level === "MODULE" && target && target in MODULE_LABELS) return MODULE_LABELS[target as ModuleName];
  if (level === "COMMAND" && target && isCommandCode(target)) return commandDef(target).label;
  return target ?? level;
}

export function isKnownSwitchTarget(level: SwitchLevel, target: string | null): boolean {
  if (level === "SYSTEM") return target === null;
  if (level === "MODULE") return target !== null && target in MODULE_LABELS;
  return target !== null && isCommandCode(target);
}

export const SWITCH_LEVEL_LABELS: Record<SwitchLevel, string> = {
  SYSTEM: "시스템 전체",
  MODULE: "모듈",
  COMMAND: "명령·조회",
};

// 화면 선택지. 공리(통제실 통로)는 뺀다 — 끌 수 없는 항목을 보여 주지 않는다.
export type SwitchOptions = {
  modules: { value: string; label: string }[];
  commandGroups: { moduleLabel: string; items: { value: string; label: string; kindLabel: "명령" | "조회" }[] }[];
};

export function switchOptions(): SwitchOptions {
  const modules = (Object.keys(MODULE_LABELS) as ModuleName[]).map((module) => ({ value: module, label: MODULE_LABELS[module] }));
  const commandGroups = modules.map(({ value, label }) => ({
    moduleLabel: label,
    items: ALL_COMMANDS.filter((c) => c.module === value && !c.axiom).map((c) => ({
      value: c.code as string,
      label: c.label,
      kindLabel: c.kind === "COMMAND" ? ("명령" as const) : ("조회" as const),
    })),
  }));
  return { modules, commandGroups: commandGroups.filter((group) => group.items.length > 0) };
}
