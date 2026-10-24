import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { one } from "@/lib/supabase/relations";
import { runQuery } from "@/lib/commands/run-command";
import { GATE_CODES, GATE_LABELS } from "@/lib/system/gates";
import type { SwitchLevel } from "@/lib/commands/rail";
import {
  isKnownSwitchTarget,
  switchOptions,
  switchTargetLabel,
  SWITCH_LEVEL_LABELS,
  type SwitchOptions,
} from "@/lib/commands/switch-input";

const ELAPSED_WARNING_HOURS = 24;
const HISTORY_LIMIT = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SwitchRowView = {
  id: string;
  /** 「시스템 전체」「모듈」「명령·조회」 */
  levelText: string;
  /** 「서비스 전체」 / 모듈 이름 / 등록부 이름 */
  targetText: string;
  /** 등록부에 없는 옛 대상이면 true — 읽을 수만 있고 의미는 사라졌다. */
  unknownTarget: boolean;
  /** 전원이면 「전원」, 아니면 그 회원 이메일. */
  userText: string;
  reason: string;
  setByEmail: string;
  setAtText: string;
  /** 24시간 넘게 켜져 있으면 "N일째 …" */
  staleWarning: string | null;
};

export type SwitchHistoryRowView = SwitchRowView & {
  clearedAtText: string;
  clearedReason: string;
  clearedByEmail: string;
};

export type AdminSystemView = {
  /** 감사 기록(AUDIT) on/off — 레일 스위치가 아니라 0층 스위치(system_gates)다. */
  gates: {
    code: string;
    label: string;
    status: "OPEN" | "CLOSED";
    /** 24시간 넘게 봉쇄 중이면 "N일째 봉쇄 중입니다. …" */
    staleWarning: string | null;
    reason: string;
    changedBy: string;
    changedAtText: string;
  }[];
  switches: {
    active: SwitchRowView[];
    history: SwitchHistoryRowView[];
    options: SwitchOptions;
    /** 학생 상세에서 넘어온 유저(이메일) — 설정 폼의 유저 칸을 미리 채운다. */
    prefillUserEmail: string | null;
  };
  paymentProvider: {
    current: "TOSS" | null;
    reason: string | null;
    changedAtText: string | null;
    changedByEmail: string | null;
    tossKeysConfigured: boolean;
  };
};

type SwitchQueryRow = {
  id: string;
  level: SwitchLevel;
  target: string | null;
  reason: string;
  set_at: string;
  cleared_at: string | null;
  cleared_reason: string | null;
  user: { email: string } | { email: string }[] | null;
  set_by_user: { email: string } | { email: string }[] | null;
  cleared_by_user: { email: string } | { email: string }[] | null;
};

function toRowView(row: SwitchQueryRow): SwitchRowView {
  const hoursElapsed = (Date.now() - new Date(row.set_at).getTime()) / 3_600_000;
  return {
    id: row.id,
    levelText: SWITCH_LEVEL_LABELS[row.level],
    targetText: switchTargetLabel(row.level, row.target),
    unknownTarget: !isKnownSwitchTarget(row.level, row.target),
    userText: one(row.user)?.email ?? "전원",
    reason: row.reason,
    setByEmail: one(row.set_by_user)?.email ?? "-",
    setAtText: new Date(row.set_at).toLocaleString("ko-KR"),
    staleWarning:
      row.cleared_at === null && hoursElapsed >= ELAPSED_WARNING_HOURS
        ? `${Math.floor(hoursElapsed / 24)}일째 켜져 있습니다. 방치된 것은 아닌지 확인해 주세요.`
        : null,
  };
}

const SWITCH_COLUMNS =
  "id, level, target, reason, set_at, cleared_at, cleared_reason, user:users!rail_switches_user_id_fkey(email), set_by_user:users!rail_switches_set_by_fkey(email), cleared_by_user:users!rail_switches_cleared_by_fkey(email)";

// ADMIN 전용(등록부 RAIL_SWITCH_VIEW who: ADMIN, 통제실 통로 — 스위치로 막히지 않는다). 매니저가 스스로 봉쇄를 해제하는 구멍을 만들지 않기 위함(매니저는 봉쇄 대상에 포함된다).
// 스위치 상태를 매번 새로 읽어야 한다(page.tsx의 force-dynamic과 짝) — 캐시된 페이지를 보여주면 "껐는데 안 꺼짐"이 생긴다.
// 학생 상세에서 넘어오면(?user=회원id) 그 회원의 이메일로 설정 폼을 미리 채운다.
export async function loadAdminSystem(input: { user?: string } = {}): Promise<AdminSystemView> {
  return runQuery({ command: "RAIL_SWITCH_VIEW" }, async () => {
    const supabase = await createClient();

    // AUDIT(감사 on/off)만 system_gates에 있다. 옛 PAYMENT/SIGNUP/LOGIN 행은 이력으로 남아 있고 더 쓰지 않는다.
    const { data: auditGate } = await supabase
      .from("system_gates")
      .select("code, status, reason, changed_at, changed_by_user:users!system_gates_changed_by_fkey(email)")
      .eq("code", "AUDIT")
      .maybeSingle();

    const [{ data: activeRows }, { data: historyRows }] = await Promise.all([
      supabase.from("rail_switches").select(SWITCH_COLUMNS).is("cleared_at", null).order("set_at", { ascending: false }),
      supabase
        .from("rail_switches")
        .select(SWITCH_COLUMNS)
        .not("cleared_at", "is", null)
        .order("cleared_at", { ascending: false })
        .limit(HISTORY_LIMIT),
    ]);

    let prefillUserEmail: string | null = null;
    if (input.user && UUID.test(input.user)) {
      const { data: prefillUser } = await supabase.from("users").select("email").eq("id", input.user).maybeSingle();
      prefillUserEmail = prefillUser?.email ?? null;
    }

    const auditChangedAt = auditGate?.changed_at ?? null;
    const auditStatus: "OPEN" | "CLOSED" = auditGate?.status === "CLOSED" ? "CLOSED" : "OPEN";
    const auditHours = auditChangedAt ? (Date.now() - new Date(auditChangedAt).getTime()) / 3_600_000 : 0;

    // payment_settings는 service_role만 읽는다(PG-1 RLS) — 관리자 화면은 admin 클라이언트로.
    const admin = createAdminClient();
    const { data: paymentSettings } = await admin
      .from("payment_settings")
      .select("active_provider, reason, changed_at, changed_by")
      .eq("id", "SINGLETON")
      .maybeSingle();

    let paymentChangedByEmail: string | null = null;
    if (paymentSettings?.changed_by) {
      const { data: changer } = await admin
        .from("users")
        .select("email")
        .eq("id", paymentSettings.changed_by)
        .maybeSingle();
      paymentChangedByEmail = changer?.email ?? null;
    }

    const active = paymentSettings?.active_provider === "TOSS" ? paymentSettings.active_provider : null;

    const tossKeysConfigured = Boolean(process.env.TOSS_SECRET_KEY && process.env.NEXT_PUBLIC_TOSS_CLIENT_KEY);

    return {
      gates: GATE_CODES.map((code) => ({
        code,
        label: GATE_LABELS[code],
        status: auditStatus,
        staleWarning:
          auditStatus === "CLOSED" && auditHours >= ELAPSED_WARNING_HOURS
            ? `${Math.floor(auditHours / 24)}일째 봉쇄 중입니다. 방치된 것은 아닌지 확인해 주세요.`
            : null,
        reason: auditGate?.reason ?? "-",
        changedBy: one(auditGate?.changed_by_user)?.email ?? "-",
        changedAtText: auditChangedAt ? new Date(auditChangedAt).toLocaleString("ko-KR") : "-",
      })),
      switches: {
        active: ((activeRows ?? []) as unknown as SwitchQueryRow[]).map(toRowView),
        history: ((historyRows ?? []) as unknown as SwitchQueryRow[]).map((row) => ({
          ...toRowView(row),
          clearedAtText: row.cleared_at ? new Date(row.cleared_at).toLocaleString("ko-KR") : "-",
          clearedReason: row.cleared_reason ?? "-",
          clearedByEmail: one(row.cleared_by_user)?.email ?? "-",
        })),
        options: switchOptions(),
        prefillUserEmail,
      },
      paymentProvider: {
        current: active,
        reason: paymentSettings?.reason ?? null,
        changedAtText: paymentSettings?.changed_at ? new Date(paymentSettings.changed_at).toLocaleString("ko-KR") : null,
        changedByEmail: paymentChangedByEmail,
        tossKeysConfigured,
      },
    };
  });
}
