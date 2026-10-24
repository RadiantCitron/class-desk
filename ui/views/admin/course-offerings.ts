import { createClient } from "@/lib/supabase/server";
import { runQuery } from "@/lib/commands/run-command";
import { one } from "@/lib/supabase/relations";
import { CONDITIONAL_TERMS_TYPES, TERMS_TYPE_LABELS } from "@/lib/terms";
import { offeringLifecycleLabel } from "@/lib/shared/offering-lifecycle";

export type OfferingListRowView = {
  id: string;
  courseName: string;
  label: string | null;
  labelText: string;
  capacityText: string;
  priceText: string;
  status: string;
  /** 종료된 강의 — 마감/재개·폐강 컨트롤을 숨긴다(상세 화면과 같다). */
  ended: boolean;
  /** "모집중" | "마감" | "폐강중(처리할 수강생 N명·DLQ M건)" | "폐강완료" */
  statusBadge: string;
  autoApprove: boolean;
  autoApproveLabel: "켜짐" | "꺼짐";
  termsText: string;
  discordRoleText: string;
  sourcePathText: string;
  detailHref: string;
  /** OPEN·CLOSED일 때만. */
  toggle: { nextStatus: "OPEN" | "CLOSED"; label: "마감" | "재개"; placeholder: "마감 사유" | "재개 사유" } | null;
  /** 폐강중일 때 남은 건(링크 글자는 "결제상태 / 수강상태"). */
  remainingOrders: { id: string; href: string; text: string; shortId: string }[];
  canDelete: boolean;
};

export type AdminCourseOfferingsView = {
  courses: { id: string; name: string }[];
  termOptions: { type: string; label: string }[];
  offerings: OfferingListRowView[];
};

// ADMIN 전용(2026-09-18, 매니저 권한표 lib/auth/permissions.ts 참고). 쿼리·집계는 원본 page 그대로다.
export async function loadAdminCourseOfferings(): Promise<AdminCourseOfferingsView> {
  return runQuery({ command: "ADMIN_COURSE_OFFERINGS_VIEW" }, async () => {
    const supabase = await createClient();
    const { data: courses } = await supabase
      .from("courses")
      .select("id, name")
      .is("deleted_at", null)
      .order("name");

    const { data: offerings } = await supabase
      .from("course_offerings")
      .select(
        "id, label, capacity, remaining_seats, price, location, recruit_opens_at, opens_at, ends_at, ended_at, status, auto_approve, required_terms_types, grants, courses(name)",
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    // 폐강중 배지용 — 처리할 수강생(승인 대기·승인됨) 수와 관련 DLQ(조회로 계산, 저장 안 함).
    const cancellingIds = (offerings ?? []).filter((o) => o.status === "CANCELLING").map((o) => o.id);
    const remainingByOffering = new Map<string, number>();
    const remainingOrdersByOffering = new Map<string, { id: string; payment_status: string; status: string }[]>();
    const dlqByOffering = new Map<string, number>();
    if (cancellingIds.length > 0) {
      const { data: remainingOrders } = await supabase
        .from("orders")
        .select("id, course_offering_id, status, payment_status")
        .in("course_offering_id", cancellingIds);
      const orderIdsByOffering = new Map<string, string[]>();
      for (const row of remainingOrders ?? []) {
        const isRemaining = row.status === "PENDING" || row.status === "APPROVED";
        if (!isRemaining) continue;
        remainingByOffering.set(row.course_offering_id, (remainingByOffering.get(row.course_offering_id) ?? 0) + 1);
        const detail = remainingOrdersByOffering.get(row.course_offering_id) ?? [];
        detail.push({ id: row.id, payment_status: row.payment_status, status: row.status });
        remainingOrdersByOffering.set(row.course_offering_id, detail);
        const list = orderIdsByOffering.get(row.course_offering_id) ?? [];
        list.push(row.id);
        orderIdsByOffering.set(row.course_offering_id, list);
      }
      const allOrderIds = [...orderIdsByOffering.values()].flat();
      if (allOrderIds.length > 0) {
        const { data: dlqs } = await supabase.from("dead_letters").select("id, payload").eq("resolved", false);
        for (const dlq of dlqs ?? []) {
          const payload = dlq.payload as { order_id?: string } | null;
          const orderId = payload?.order_id;
          if (!orderId || typeof orderId !== "string") continue;
          for (const [offeringId, ids] of orderIdsByOffering) {
            if (ids.includes(orderId)) {
              dlqByOffering.set(offeringId, (dlqByOffering.get(offeringId) ?? 0) + 1);
              break;
            }
          }
        }
      }
    }

    function statusBadge(offering: {
      id: string;
      status: string;
      recruit_opens_at: string | null;
      opens_at: string;
      ends_at: string | null;
      ended_at: string | null;
    }) {
      if (offering.status === "CANCELLING") {
        const n = remainingByOffering.get(offering.id) ?? 0;
        const m = dlqByOffering.get(offering.id) ?? 0;
        return `폐강중(처리할 수강생 ${n}명·DLQ ${m}건)`;
      }
      // 그 밖의 표시(모집 전/모집중/마감/강의 중/종료 처리 대기/종료/폐강완료)는 날짜와 종료 기록에서 계산한다.
      return offeringLifecycleLabel(offering);
    }

    return {
      courses: (courses ?? []).map((c) => ({ id: c.id, name: c.name })),
      termOptions: CONDITIONAL_TERMS_TYPES.map((type) => ({ type, label: TERMS_TYPE_LABELS[type] ?? type })),
      offerings: (offerings ?? []).map((offering) => {
        const grants = offering.grants as { type: string; discord_role_id?: string; blob_pathname?: string }[] | null;
        return {
          id: offering.id,
          courseName: one(offering.courses)?.name ?? "",
          label: offering.label ?? null,
          labelText: offering.label ?? "-",
          capacityText: `${offering.capacity}명 (잔여 ${offering.remaining_seats})`,
          priceText: `${offering.price.toLocaleString()}원`,
          status: offering.status,
          ended: !!offering.ended_at,
          statusBadge: statusBadge(offering),
          autoApprove: !!offering.auto_approve,
          autoApproveLabel: offering.auto_approve ? "켜짐" : "꺼짐",
          termsText:
            offering.required_terms_types.length > 0
              ? offering.required_terms_types.map((t: string) => TERMS_TYPE_LABELS[t] ?? t).join(", ")
              : "-",
          discordRoleText: grants?.find((g) => g.type === "DISCORD_ROLE")?.discord_role_id ?? "-",
          sourcePathText: grants?.find((g) => g.type === "SOURCE_DOWNLOAD")?.blob_pathname ?? "-",
          detailHref: `/admin/course-offerings/${offering.id}`,
          toggle:
            !offering.ended_at && (offering.status === "OPEN" || offering.status === "CLOSED")
              ? offering.status === "OPEN"
                ? ({ nextStatus: "CLOSED", label: "마감", placeholder: "마감 사유" } as const)
                : ({ nextStatus: "OPEN", label: "재개", placeholder: "재개 사유" } as const)
              : null,
          remainingOrders: (remainingOrdersByOffering.get(offering.id) ?? []).map((o) => ({
            id: o.id,
            href: `/admin/orders/${o.id}`,
            text: `${o.payment_status} / ${o.status}`,
            shortId: `${o.id.slice(0, 8)}…`,
          })),
          canDelete: offering.status !== "CANCELLING" && offering.status !== "CANCELLED",
        };
      }),
    };
  });
}
