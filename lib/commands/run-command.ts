import { randomUUID } from "crypto";
import { getCurrentProfile, type Profile } from "@/lib/supabase/identity";
import { recordAudit, getAuditSink } from "@/lib/audit";
import { UserFacingError } from "@/lib/errors";
import { commandDef, type CommandCode, type PublicCode, type QueryCode } from "./registry";
import { checkRail } from "./check";
import type { RailDenial } from "./rail";

// CS 명령 파이프라인 = 명령 레일의 단일 진입점: 상태를 변경하는 모든 서버 액션이 이 함수를 거친다(ADR-0015). 순서가 곧 규칙이다:
//   1 신원    세션 → 우리 users.id. 모르면 기록하지 않고 거부(행위자 없는 감사는 노이즈). 신원 전에 하는 명령(who: PUBLIC — 로그인·가입·
//             로그아웃)은 actor가 null일 수 있고, 그때는 기록이 없다(가입 마무리만 성공 결과의 actorProfileId로 성공 행을 남긴다).
//             호출부가 신원을 이미 아는 곳(route handler — 방금 verifyOtp한 세션은 쿠키로 아직 안 보인다)은 identity로 넘긴다.
//   2 시도    감사 ATTEMPTED — 레일·가드보다 먼저라 막힌 시도도 남는다(보안 추적).
//   3 레일    checkRail → railVerdict(lib/commands/rail.ts, 화면과 같은 판정) — 통제 스위치(시스템 → 모듈 → 명령, 전원·본인)와 역할(등록부 who).
//             관리자 면제는 없다(모든 유저는 같다). 예외는 등록부의 공리(통제실 통로)뿐이다. 스위치를 못 읽으면 거부한다
//             (fail-closed). 거부하면 감사 FAILED(detail.rail_denied) 후 사용자 문구로 던진다.
//   4 가드    spec.guard(actor) — 업무 자격만(약관·결제 자격 등. 역할은 3이 본다). 실패하면 감사 FAILED(detail.guard_denied).
//             가드가 돌려준 값은 실행 함수의 두 번째 인자로 넘어간다(예: 결제 자격검증이 읽은 주문 금액).
//   5 실행    fn — 한 모듈의 명령 1개(R6). 업무 정합성의 최종 판정은 그 모듈의 DB 함수가 한다.
//   6 결과    감사 SUCCEEDED / FAILED.
// 명령의 소속 모듈·역할·기록 여부는 호출부가 아니라 등록부(lib/commands/registry.ts)가 정한다 — 호출부는 이름만 넘긴다.
// 대사(정합성) 점검은 여기서 하지 않는다 — 아웃박스 러너 배치 끝에서 돈다(lib/outbox/drain.ts, V8).
//
// 시도 기록과 결과 기록을 나눈 이유(2단계 기록): 상태 변경과 감사 기록이 한 트랜잭션이 아니므로,
// 실행 도중 프로세스가 죽으면 결과 행이 영영 안 남을 수 있다 — 그래도 ATTEMPTED 행은 이미 남아
// 있으므로 "무언가 시도됐다가 끊겼다"는 사실만은 항상 알 수 있다.
//
// 주의: fn 안에서 redirect()를 부르지 않는다. Next.js의 redirect는 예외를 던져서 동작하므로 여기서
// FAILED로 기록된다. redirect는 runCommand()가 돌아온 뒤 서버 액션에서 부른다.

export type CommandOutput<T> = {
  result: T;
  // 신원 전 명령(가입)이 성공한 뒤에야 행위자(새 users.id)가 생기는 경우, 성공 행의 행위자로 쓴다. 신원이 있으면 무시한다.
  actorProfileId?: string;
  targetId?: string | null;
  targetRef?: string | null;
  detail?: Record<string, unknown>;
};

// 대상 행을 명령이 시작되기 전에 이미 아는 경우(주문 상세에서 부르는 환불 등)의 선택 지정 — 실행 함수(fn)가
// 던지면 반환값(targetId)을 받을 수 없어 FAILED 감사 행의 target_id가 비던 문제(2026-10-02 R-5)를 막는다.
// ATTEMPTED·가드 거부·FAILED 행에 기록되고, SUCCEEDED 행은 fn이 돌려준 값이 있으면 그것을 우선한다.
export type CommandTarget = {
  targetId?: string | null;
  targetRef?: string | null;
};

// who가 PUBLIC인 명령만 actor가 null일 수 있고, 나머지는 레일이 신원을 보증한다.
export type CommandActor<C extends CommandCode> = C extends PublicCode ? Profile | null : Profile;

export type CommandSpec<G, C extends CommandCode = CommandCode> = {
  command: C;
  targetTable: string;
  target?: CommandTarget;
  // 신원을 호출부가 이미 아는 경우(route handler·가입 마무리). 생략하면 세션에서 읽는다(getCurrentProfile).
  identity?: { actor: Profile | null };
  // 업무 자격 검사(선택). 역할·탈퇴 여부·통제 스위치는 레일이 이미 봤다.
  guard?: (actor: CommandActor<C>) => G | Promise<G>;
};

export async function runCommand<C extends CommandCode, T, G = void>(
  spec: CommandSpec<G, C>,
  fn: (actor: CommandActor<C>, guarded: G) => Promise<CommandOutput<T>>,
): Promise<T> {
  const actor = spec.identity ? spec.identity.actor : await getCurrentProfile();
  const def = commandDef(spec.command);
  if (!actor && def.who !== "PUBLIC") {
    throw new UserFacingError("로그인이 필요합니다.");
  }

  const correlationId = randomUUID();
  // sink를 이 커맨드 시작 시점에 한 번만 고르고 끝까지 재사용한다 — 실행 도중 AUDIT
  // 게이트 상태가 바뀌어도(가장 흔한 경우: 이 커맨드 자체가 AUDIT을 끄는 RAIL_SWITCH_SET
  // 커맨드일 때) ATTEMPTED와 결과 기록이 같은 결정을 따르게 하기 위함이다. 이래야 "감사를
  // 끄는 그 조작 자체"가 SUCCEEDED까지 온전히 남는다.
  const sink = await getAuditSink();
  const base = {
    action: spec.command,
    targetTable: spec.targetTable,
    targetId: spec.target?.targetId,
    targetRef: spec.target?.targetRef,
    correlationId,
  };
  // 행위자가 없으면(신원 전 명령) 기록하지 않는다 — 행위자 없는 감사는 노이즈다.
  const attributed = actor ? { ...base, actorProfileId: actor.id } : null;

  const audited = def.audit === "FULL";
  if (audited && attributed) await recordAudit({ ...attributed, phase: "ATTEMPTED" }, sink);

  const verdict = await checkRail(spec.command, actor);
  if (!verdict.ok) {
    // 레일 거부는 기록 여부(audit)와 무관하게 항상 남긴다 — 무엇이 어느 층의 어느 스위치에 막혔는지가 통제의 근거다.
    if (attributed) {
      await recordAudit(
        {
          ...attributed,
          detail: {
            error: verdict.message,
            rail_denied: { check: verdict.check, layer: verdict.layer ?? null, switchId: verdict.switchId ?? null },
          },
          phase: "FAILED",
        },
        sink,
      );
    }
    throw new UserFacingError(verdict.message);
  }

  let guarded: G;
  try {
    guarded = spec.guard ? await spec.guard(actor as CommandActor<C>) : (undefined as G);
  } catch (err) {
    if (audited && attributed) await recordAudit(
      {
        ...attributed,
        detail: { error: err instanceof Error ? err.message : String(err), guard_denied: true },
        phase: "FAILED",
      },
      sink,
    );
    throw err;
  }

  try {
    const { result, actorProfileId, targetId, targetRef, detail } = await fn(actor as CommandActor<C>, guarded);
    const successActor = !audited ? null : (attributed ?? (actorProfileId ? { ...base, actorProfileId } : null));
    if (successActor) {
      await recordAudit(
        { ...successActor, targetId: targetId ?? base.targetId, targetRef: targetRef ?? base.targetRef, detail, phase: "SUCCEEDED" },
        sink,
      );
    }
    return result;
  } catch (err) {
    if (audited && attributed) {
      await recordAudit(
        { ...attributed, detail: { error: err instanceof Error ? err.message : String(err) }, phase: "FAILED" },
        sink,
      );
    }
    throw err;
  }
}

// ── runQuery — 조회(화면 읽기)의 입구·출구 (ADR-0015) ─────────────────────────────────────
// ui/views의 조회 로더 29개가 이 함수 하나를 거친다. runCommand와 같은 레일 판정(checkRail)을 받는다 — 스위치(시스템 → 모듈 →
// 조회 이름, 전원·본인)와 등록부 who. 관리자 면제는 없다. 순서:
//   1 신원    세션 → 우리 users.id. 신원이 없어도 되는 조회(who: PUBLIC — 로그인·가입 전 화면)는 actor가 null일 수 있다.
//   2 시도    등록부 audit이 FULL일 때만 ATTEMPTED. 조회의 기본은 OFF라 통과·결과는 남지 않는다 — 열람 기록이 필요해지면 그
//             조회의 등록부 줄에 audit: "FULL"만 적는다(코드 변경 없음).
//   3 레일    거부는 audit과 무관하게 항상 FAILED로 남긴다(무엇이 어느 층의 어느 스위치에 막혔는지가 통제의 근거). 단 행위자가
//             없으면(로그인 전 화면) 기록하지 않는다 — runCommand와 같은 사유(행위자 없는 감사는 노이즈).
//             거부하면 onDenied가 있을 때 그 값을 돌려주고(화면이 "제한됨" 상태를 직접 보여 주는 경우), 없으면 UserFacingError로 던진다.
//   4 실행    fn — 읽기만 한다(ui/views는 쓰기 호출 금지, ui-layer.guard).
//   5 결과    audit이 FULL일 때만 SUCCEEDED / FAILED.
// fn 안의 redirect()·notFound()는 Next.js가 예외로 구현한 제어 흐름이라 FAILED로 기록하지 않고 그대로 통과시킨다
// (runCommand는 fn 안에서 redirect를 금지했지만, 화면 로더는 조건에 따라 redirect하는 것이 정상 흐름이다).
const QUERY_TARGET_TABLE = "view";

export type QuerySpec<C extends QueryCode, T> = {
  command: C;
  // 레일이 거부했을 때 예외 대신 돌려줄 값. 학생 홈처럼 화면이 직접 사유를 보여 주거나, 관리자 메뉴·건수처럼 거부돼도
  // 화면 틀이 무너지면 안 되는 곳에서만 쓴다.
  onDenied?: (denial: RailDenial) => T;
};

// 신원 없이 열리는 조회는 actor가 null일 수 있고, 나머지는 레일이 신원을 보증한다.
export type QueryActor<C extends QueryCode> = C extends PublicCode ? Profile | null : Profile;

function isNextControlFlow(err: unknown): boolean {
  const digest = typeof err === "object" && err !== null ? (err as { digest?: unknown }).digest : undefined;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

export async function runQuery<C extends QueryCode, T>(
  spec: QuerySpec<C, T>,
  fn: (actor: QueryActor<C>) => Promise<T>,
): Promise<T> {
  const def = commandDef(spec.command);
  if (def.kind !== "QUERY") {
    throw new Error(`runQuery는 조회만 실행한다(${spec.command}은 ${def.kind})`);
  }

  const actor = await getCurrentProfile();
  const correlationId = randomUUID();
  const base = actor
    ? { actorProfileId: actor.id, action: spec.command, targetTable: QUERY_TARGET_TABLE, correlationId }
    : null;

  // 기록 대상(FULL이거나 거부)일 때만 sink를 고른다 — 기본 조회(OFF·통과)는 감사 저장소를 건드리지 않는다.
  const audited = def.audit === "FULL" && base !== null;
  const sink = audited ? await getAuditSink() : null;
  if (audited && base && sink) await recordAudit({ ...base, phase: "ATTEMPTED" }, sink);

  const verdict = await checkRail(spec.command, actor);
  if (!verdict.ok) {
    if (base) {
      await recordAudit(
        {
          ...base,
          detail: {
            error: verdict.message,
            rail_denied: { check: verdict.check, layer: verdict.layer ?? null, switchId: verdict.switchId ?? null },
          },
          phase: "FAILED",
        },
        sink ?? (await getAuditSink()),
      );
    }
    if (spec.onDenied) return spec.onDenied(verdict);
    throw new UserFacingError(verdict.message);
  }

  try {
    const result = await fn(actor as QueryActor<C>);
    if (audited && base && sink) await recordAudit({ ...base, phase: "SUCCEEDED" }, sink);
    return result;
  } catch (err) {
    if (audited && base && sink && !isNextControlFlow(err)) {
      await recordAudit(
        { ...base, detail: { error: err instanceof Error ? err.message : String(err) }, phase: "FAILED" },
        sink,
      );
    }
    throw err;
  }
}
