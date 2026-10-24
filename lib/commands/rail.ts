import { whoDenial, type Permissions, type Role } from "@/lib/auth/permissions";
import { MODULE_LABELS } from "@/lib/architecture/module-map";
import { commandDef, type CommandCode, type ResolvedCommandDef } from "./registry";

// 명령 레일의 판정 — 순수함수(DB·세션 접근 없음). 모든 명령과 조회가 이 판정 하나를 지난다
// (ADR-0015)
//
// 판정은 체크 목록(RAIL_CHECKS)을 앞에서부터 돌려 처음 거부에서 멈춘다. 순서가 곧 규칙이다:
// 1 스위치를 읽었는가 — 못 읽었으면 거부(fail-closed v4 3항)
//   2 스위치 — 시스템 → 모듈 → 명령, 각 층에서 전원 대상 → 본인 대상
//   3 역할·권한(who) — 판정은 lib/auth/permissions.ts의 whoDenial(옛 assertActive/assertAdmin/assertStaff/assertPermission과 같은 판정·같은 문구)
// 관리자 면제는 없다(모든 유저는 같다, v3). 예외는 등록부의 axiom(통제실 통로) 하나뿐이고, 그것도 1·2만 건너뛴다.
// 새 통제 종류는 체크 1개 + 배열 1줄로 추가한다(lib/guards/checkout/index.ts RULES와 같은 관례).

export type SwitchLevel = "SYSTEM" | "MODULE" | "COMMAND";

// rail_switches의 활성 행 하나(CR-2에서 테이블이 생긴다). target: SYSTEM이면 null, MODULE이면 모듈명, COMMAND이면 명령 이름.
// userId: null이면 전원, 값이면 그 유저만.
export type ActiveSwitch = {
  id: string;
  level: SwitchLevel;
  target: string | null;
  userId: string | null;
  reason: string;
  setAt: string;
};

export type SwitchSnapshot = { readable: true; switches: readonly ActiveSwitch[] } | { readable: false };

// lib/supabase/identity.ts의 Profile이 구조적으로 맞는다. null = 신원 전(로그인·가입 전).
export type RailActor = {
  id: string;
  role: Role;
  permissions: Permissions;
  withdrawnAt: string | null;
} | null;

export type RailContext = {
  def: ResolvedCommandDef;
  actor: RailActor;
  switches: SwitchSnapshot;
};

export type RailDenial = {
  check: string;
  message: string;
  layer?: SwitchLevel;
  switchId?: string;
};

export type RailCheck = {
  code: string;
  evaluate: (ctx: RailContext) => RailDenial | null;
};

export type RailVerdict = { ok: true } | ({ ok: false } & RailDenial);

const SWITCHES_UNREADABLE_MESSAGE = "이용 제한 상태를 확인할 수 없어 지금은 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.";

const switchesReadable: RailCheck = {
  code: "SWITCHES_READABLE",
  evaluate: ({ def, switches }) =>
    def.axiom || switches.readable ? null : { check: "SWITCHES_READABLE", message: SWITCHES_UNREADABLE_MESSAGE },
};

// 층마다 이 명령에 해당하는 target. SYSTEM은 target이 없다.
function targetFor(level: SwitchLevel, def: ResolvedCommandDef): string | null {
  if (level === "SYSTEM") return null;
  if (level === "MODULE") return def.module;
  return def.code;
}

function switchMessage(level: SwitchLevel, def: ResolvedCommandDef, own: boolean, reason: string): string {
  if (level === "SYSTEM") {
    return own ? `관리자에 의해 계정 이용이 제한되었습니다: ${reason}` : `서비스가 일시 중단되었습니다: ${reason}`;
  }
  const label = level === "MODULE" ? MODULE_LABELS[def.module] : def.label;
  return own ? `관리자에 의해 ${label} 기능이 제한되었습니다: ${reason}` : `${label} 기능이 일시 중단되었습니다: ${reason}`;
}

const LEVEL_ORDER: readonly SwitchLevel[] = ["SYSTEM", "MODULE", "COMMAND"];

const switchesClosed: RailCheck = {
  code: "SWITCH",
  evaluate: ({ def, actor, switches }) => {
    if (def.axiom || !switches.readable) return null;
    for (const level of LEVEL_ORDER) {
      const target = targetFor(level, def);
      const hits = switches.switches.filter((s) => s.level === level && s.target === target);
      const everyone = hits.find((s) => s.userId === null);
      const own = actor ? hits.find((s) => s.userId === actor.id) : undefined;
      const hit = everyone ?? own;
      if (hit) {
        return {
          check: "SWITCH",
          layer: level,
          switchId: hit.id,
          message: switchMessage(level, def, hit === own && !everyone, hit.reason),
        };
      }
    }
    return null;
  },
};

// 판정 규칙·문구는 lib/auth/permissions.ts의 whoDenial 하나다(/admin 경로 판정과 공유) — 옛 assertActive/assertAdmin/assertStaff/
// assertPermission·app/reactivate/actions.ts의 문구와 한 글자도 다르지 않다.
const who: RailCheck = {
  code: "WHO",
  evaluate: ({ def, actor }) => {
    const message = whoDenial(def.who, actor);
    return message ? { check: "WHO", message } : null;
  },
};

export const RAIL_CHECKS: readonly RailCheck[] = [switchesReadable, switchesClosed, who];

export function railVerdict(command: CommandCode, actor: RailActor, switches: SwitchSnapshot): RailVerdict {
  const ctx: RailContext = { def: commandDef(command), actor, switches };
  for (const check of RAIL_CHECKS) {
    const denial = check.evaluate(ctx);
    if (denial) return { ok: false, ...denial };
  }
  return { ok: true };
}
