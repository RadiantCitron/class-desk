import { createClient } from "@/lib/supabase/server";
import { runQuery } from "@/lib/commands/run-command";
import { one } from "@/lib/supabase/relations";
import { listStudentAuditLogs } from "@/lib/audit/read";
import { switchTargetLabel, SWITCH_LEVEL_LABELS } from "@/lib/commands/switch-input";
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from "./order-labels";

export type StudentTimelineKind = "AUDIT" | "ENROLLMENT" | "PAYMENT" | "ACCOUNT";

export type StudentDetailView =
  | { kind: "notFound" }
  | {
      kind: "ok";
      isAdmin: boolean;
      studentId: string;
      /** h1: 이름이 없으면 이메일. */
      title: string;
      discordId: string | null;
      email: string;
      phone: string;
      joinedText: string;
      statusText: "탈퇴" | "활동중";
      orders: {
        id: string;
        itemName: string;
        createdText: string;
        statusText: string;
        paymentText: string;
        amountText: string;
        href: string;
      }[];
      /** ADMIN만. 이 학생에게 켜져 있는 통제 스위치. 매니저는 null(RLS가 빈 목록을 주므로 "제한 0"으로 오해하지 않게 안내만). 설정·해제는 스위치 화면에서 한다. */
      switches: { id: string; levelText: string; targetText: string; reason: string; setAtText: string }[] | null;
      /** 스위치 화면으로 가는 링크 — 이 학생으로 유저 칸이 미리 채워진다. */
      switchScreenHref: string;
      timeline: {
        id: string;
        kind: StudentTimelineKind;
        kindLabel: string;
        label: string;
        detail: string;
        timeText: string;
        href: string | null;
      }[];
    };

type TimelineItem = {
  id: string;
  createdAt: string;
  kind: StudentTimelineKind;
  label: string;
  detail: string;
  href?: string;
};

const ACCOUNT_LABELS: Record<string, string> = {
  IDENTITY_LINKED: "디스코드 연결",
  IDENTITY_LINK_FAILED: "디스코드 연결 실패",
  SIGNED_UP: "가입",
  WITHDRAWN: "탈퇴",
  REACTIVATED: "복구",
  EMAIL_CHANGED: "이메일 변경",
};

const KIND_LABELS: Record<StudentTimelineKind, string> = { AUDIT: "관리", ENROLLMENT: "신청", ACCOUNT: "회원", PAYMENT: "결제" };

// 수강생 한 명의 전체 이력을 한 화면에서 본다(2026-09-20 감사 모듈 재설계 5단계).
export async function loadAdminStudentDetail(studentId: string): Promise<StudentDetailView> {
  return runQuery({ command: "ADMIN_STUDENT_DETAIL_VIEW" }, async (profile) => {
    // 목록 화면과 동일한 권한(VIEW_STUDENTS 또는 APPROVE_ORDERS). 감사로그 섹션만 ADMIN 전용으로 아래에서 추가로 가른다.
    const isAdmin = profile.role === "ADMIN";

    const supabase = await createClient();

    // discord_id는 2026-09-27부터 users가 아니라 discord_accounts(이용권 모듈)에서 온다.
    const { data: student } = await supabase
      .from("users")
      .select("id, email, name, phone, created_at, withdrawn_at, discord_accounts(discord_id)")
      .eq("id", studentId)
      .eq("role", "STUDENT")
      .maybeSingle();
    const studentDiscordId = one(student?.discord_accounts)?.discord_id ?? null;

    if (!student) {
      return { kind: "notFound" };
    }

    // 수강 내역 표(주문 1건 = 1행, 상세는 주문 상세로 링크)와 타임라인 조회용 주문 ID를 같이 얻는다.
    const { data: orders } = await supabase
      .from("orders")
      .select("id, created_at, status, payment_status, final_amount, course_offerings(label, courses(name)), products(name)")
      .eq("user_id", studentId)
      .order("created_at", { ascending: false });
    const orderIds = (orders ?? []).map((o) => o.id);

    const [{ data: orderEvents }, { data: paymentEvents }, { data: accountEvents }, auditLogs, switchRows] =
      await Promise.all([
        // order_events·payment_events RLS도 관리자·본인만 허용한다 — 매니저에게 조용히 빈 타임라인이 오지 않게 ADMIN일 때만 조회한다.
        orderIds.length > 0 && isAdmin
          ? supabase
              .from("order_events")
              .select("id, event_type, actor, created_at, order_id, orders(course_offerings(label, courses(name)))")
              .in("order_id", orderIds)
              .order("created_at", { ascending: false })
          : Promise.resolve({ data: [] }),
        orderIds.length > 0 && isAdmin
          ? supabase
              .from("payment_events")
              .select("id, event_type, amount, created_at")
              .in("order_id", orderIds)
              .order("created_at", { ascending: false })
          : Promise.resolve({ data: [] }),
        // account_events(이메일 변경·디스코드 연결·탈퇴·복구 이력)는 감사로그와 별개 원장이다. RLS가 is_admin()만 허용하므로 ADMIN 전용으로 가른다.
        isAdmin
          ? supabase
              .from("account_events")
              .select("id, event_type, actor, detail, created_at")
              .eq("user_id", studentId)
              .order("created_at", { ascending: false })
          : Promise.resolve({ data: null }),
        isAdmin ? listStudentAuditLogs(supabase, studentId, orderIds) : Promise.resolve({ data: null }),
        // 이 학생에게 켜져 있는 통제 스위치(rail_switches의 그 학생 대상 행). RLS는 is_admin()만 타인 행을
        // 볼 수 있다 — ADMIN 전용으로 가른다.
        isAdmin
          ? supabase
              .from("rail_switches")
              .select("id, level, target, user_id, reason, set_at")
              .eq("user_id", studentId)
              .is("cleared_at", null)
          : Promise.resolve({ data: null, error: null }),
      ]);

    // 조회가 실패하면(error) 빈 목록처럼 보이지 않게 null로 둔다 — 화면은 「확인할 수 없습니다」를 보인다.
    const switches =
      isAdmin && !switchRows.error && switchRows.data
        ? switchRows.data.map((r) => ({
            id: r.id,
            levelText: SWITCH_LEVEL_LABELS[r.level as keyof typeof SWITCH_LEVEL_LABELS],
            targetText: switchTargetLabel(r.level, r.target),
            reason: r.reason,
            setAtText: new Date(r.set_at).toLocaleString("ko-KR"),
          }))
        : null;

    const timeline: TimelineItem[] = [
      ...(orderEvents ?? []).map((e) => ({
        id: `order-${e.id}`,
        createdAt: e.created_at,
        kind: "ENROLLMENT" as const,
        label: `신청 이벤트: ${e.event_type}`,
        detail: `${one(one(e.orders)?.course_offerings)?.label ?? ""} ${
        one(one(one(e.orders)?.course_offerings)?.courses)?.name ?? ""
      } (행위자: ${e.actor})`,
        href: `/admin/orders/${e.order_id}`,
      })),
      ...(paymentEvents ?? []).map((p) => ({
        id: `payment-${p.id}`,
        createdAt: p.created_at,
        kind: "PAYMENT" as const,
        label: `결제 이벤트: ${p.event_type}`,
        detail: `${p.amount.toLocaleString()}원`,
      })),
      ...(accountEvents ?? []).map((a) => ({
        id: `account-${a.id}`,
        createdAt: a.created_at,
        kind: "ACCOUNT" as const,
        label: ACCOUNT_LABELS[a.event_type] ?? `회원 이벤트: ${a.event_type}`,
        detail: `행위자: ${a.actor}${a.detail ? " " + JSON.stringify(a.detail) : ""}`,
      })),
      ...(auditLogs.data ?? []).map((a) => ({
        id: `audit-${a.id}`,
        createdAt: a.created_at,
        kind: "AUDIT" as const,
        label: `${a.action}${a.phase === "FAILED" ? " (실패)" : ""}`,
        detail: `${a.target_table}${a.target_id ? `/${a.target_id.slice(0, 8)}…` : ""}${
        a.target_ref ? `/${a.target_ref}` : ""
      } ${JSON.stringify(a.detail)}`,
      })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return {
      kind: "ok",
      isAdmin,
      studentId,
      title: student.name ?? student.email,
      discordId: studentDiscordId,
      email: student.email,
      phone: student.phone ?? "-",
      joinedText: new Date(student.created_at).toLocaleString("ko-KR"),
      statusText: student.withdrawn_at ? "탈퇴" : "활동중",
      orders: (orders ?? []).map((o) => {
        const offering = one(o.course_offerings);
        const itemName = offering
          ? `${one(offering.courses)?.name ?? "-"}${offering.label ? ` (${offering.label})` : ""}`
          : (one(o.products)?.name ?? "-");
        return {
          id: o.id,
          itemName,
          createdText: new Date(o.created_at).toLocaleDateString("ko-KR"),
          statusText: ORDER_STATUS_LABELS[o.status] ?? o.status,
          paymentText: PAYMENT_STATUS_LABELS[o.payment_status] ?? o.payment_status,
          amountText: o.final_amount != null ? `${o.final_amount.toLocaleString()}원` : "-",
          href: `/admin/orders/${o.id}`,
        };
      }),
      switches,
      switchScreenHref: `/admin/system?user=${studentId}`,
      timeline: timeline.map((item) => ({
        id: item.id,
        kind: item.kind,
        kindLabel: KIND_LABELS[item.kind],
        label: item.label,
        detail: item.detail,
        timeText: new Date(item.createdAt).toLocaleString("ko-KR"),
        href: item.href ?? null,
      })),
    };
  });
}
