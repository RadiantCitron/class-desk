"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { runCommand } from "@/lib/commands/run-command";
import { runOutboxBatch } from "@/lib/wiring/outbox";
import { ordersWithOpenRefundRequest } from "@/lib/guards/offering-cancel-settled";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";

// order_events는 클라이언트 insert가 RLS로 막혀 있다(설계상 의도). 관리자/매니저 서버
// 액션에서만 service_role로 기록한다.
//
// ADMIN 전용(requireAdminProfile)에서 APPROVE_ORDERS 권한이 있는 매니저도
// 수행할 수 있도록 확장(당시 runStaffCommand, 지금은 등록부 who: { anyPermission: ["APPROVE_ORDERS"] }). 승인·반려·취소가 이제까지 감사로그(audit_logs)에
// 안 남던 구멍도 함께 고친다(전수조사에서 발견, 2026-09-18) — order_events(업무 이벤트)
// 기록은 그대로 유지하고, audit_logs(누가 이 조작을 했는지)를 추가로 남긴다.
//
// 반려 사유 입력은 2026-09-23 DB 구조 재정립 3단계에서 제거했다("반려 사유는
// 없어도 된다"). transition_order()의 사유 인자도 같은 단계에서 없앴다. 함수·테이블 이름은
// 같은 재정립의 4단계에서 enrollments → orders로 바뀌었다.
//
// 예상된 실패는 UserFacingError + runAction으로 감싼다 —
// transition_order()의 에러 메시지(new Error(error.message))는 이 함수가 그대로 사용자에게
// 보여도 되게 만든 문구다(DB 함수가 내부 사정을 섞지 않는다는 관례).
async function transitionOrder(
  orderId: string,
  eventType: "APPROVED" | "REJECTED" | "CANCELLED",
  nextStatus: "APPROVED" | "REJECTED" | "CANCELLED",
  reason?: string | null,
): Promise<ActionResult> {
  return runAction(async () => {
    const trimmedReason = reason?.trim() || null;
    if ((nextStatus === "REJECTED" || nextStatus === "CANCELLED") && !trimmedReason) {
      throw new UserFacingError(
        nextStatus === "REJECTED" ? "반려(거절) 사유를 입력해 주세요." : "취소 사유를 입력해 주세요.",
      );
    }

    const action =
      eventType === "APPROVED"
        ? "ORDER_APPROVE"
        : eventType === "REJECTED"
          ? "ORDER_REJECT"
          : "ORDER_CANCEL";

    await runCommand({ command: action, targetTable: "orders" }, async (actorProfile) => {
      const admin = createAdminClient();

      // 미인증 학생 동결 체크 + 이벤트 기록 + 상태 전이 + 좌석 반환을 하나의 트랜잭션으로
      // 묶는다(원자성 위험 유형 2 해결).
      const { error } = await admin.rpc("transition_order", {
        p_order_id: orderId,
        p_actor_id: actorProfile.id,
        // DB 함수가 users.role을 읽지 않도록, runCommand가 이미 확정한
        // 행위자 역할을 그대로 넘긴다.
        p_actor_role: actorProfile.role,
        p_event_type: eventType,
        p_next_status: nextStatus,
        p_reason: trimmedReason,
      });

      if (error) {
        throw new UserFacingError(error.message);
      }

      revalidatePath("/admin/orders");

      return {
        result: null,
        targetId: orderId,
        detail: { event_type: eventType, next_status: nextStatus, reason: trimmedReason },
      };
    });
  });
}

export async function approveOrder(
  orderId: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const reason = String(formData.get("reason") ?? "");
  return transitionOrder(orderId, "APPROVED", "APPROVED", reason);
}

export async function rejectOrder(
  orderId: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const reason = String(formData.get("reason") ?? "");
  return transitionOrder(orderId, "REJECTED", "REJECTED", reason);
}

// 관리자·매니저가 이미 승인된(APPROVED) 신청을 취소한다 — 결제 전(UNPAID)에만 허용(위 가드 참고).
export async function cancelOrderByAdmin(
  orderId: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const reason = String(formData.get("reason") ?? "");
  return transitionOrder(orderId, "CANCELLED", "CANCELLED", reason);
}

// 관리자 직권 수강 부여(ADR-0020) — 결제 없이 수강권을 준다(초대·무료 수강 등). ADMIN 전용.
// 상태 변경(결제 상태 WAIVED + 주문 이벤트 ACCESS_GRANTED + 아웃박스 사실)은 DB 함수 grant_order_access()가
// 한 트랜잭션으로 한다. 이용권·디스코드 역할은 이용권 모듈이 그 사실(ORDER_ACCESS_GRANTED)에 반응해 부여한다.
// 결제 원장에는 아무것도 쓰지 않는다(거짓 입금 기록 없음). 사유는 필수이며 주문 이벤트와 감사 기록에 남는다.
export async function grantOrderAccess(
  orderId: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      throw new UserFacingError("직권 부여 사유를 입력해 주세요.");
    }

    await runCommand({ command: "ORDER_ACCESS_GRANT", targetTable: "orders", target: { targetId: orderId } }, async (actorProfile) => {
      const admin = createAdminClient();
      const { data: grantEventId, error } = await admin.rpc("grant_order_access", {
        p_order_id: orderId,
        p_actor_id: actorProfile.id,
        p_actor_role: actorProfile.role,
        p_reason: reason,
      });
      if (error) {
        // DB 함수의 문구는 사용자에게 그대로 보여도 되게 만든 것이다(transition_order와 같은 관례).
        throw new UserFacingError(error.message);
      }

      // 수동 결제 확정과 같은 이유로 즉시 한 번 드레인해 이용권이 바로 보이게 한다. 실패해도 DB 기록은 이미 끝났고
      // 다음 드레인에서 재시도된다.
      try {
        await runOutboxBatch();
      } catch (err) {
        console.error("직권 수강 부여 직후 아웃박스 드레인 실패(다음 드레인에서 재시도):", err);
      }

      return { result: null, targetId: orderId, detail: { reason, grant_event_id: grantEventId } };
    });

    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath("/admin/orders");
    revalidatePath("/student");
  });
}

// 폐강 중 학생 처리 — 환불 없이 수강 종료(ADR-0021). ADMIN 전용. 돈은 그대로 두고(결제 상태 불변) 수강만 종료하며
// 이용권·디스코드 역할은 사실 ORDER_CLOSED로 회수된다. 진행 중인 환불 요청이 있으면 건너뛰지 않고 거부한다(원장은 결제 모듈 소유라
// 주문 모듈 DB 함수가 못 보므로 여기서 CS 가드로 확인). 사유 필수.
async function closeOne(orderId: string, reason: string) {
  await runCommand({ command: "ORDER_CLOSE_WITHOUT_REFUND", targetTable: "orders", target: { targetId: orderId } }, async (actorProfile) => {
    const open = await ordersWithOpenRefundRequest([orderId]);
    if (open.has(orderId)) {
      throw new UserFacingError("환불 요청이 아직 진행 중입니다. 환불이 끝나거나 실패로 표시한 뒤에 종료하세요.");
    }
    const admin = createAdminClient();
    const { data: closeEventId, error } = await admin.rpc("close_order_without_refund", {
      p_order_id: orderId,
      p_actor_id: actorProfile.id,
      p_actor_role: actorProfile.role,
      p_reason: reason,
    });
    if (error) {
      throw new UserFacingError(error.message);
    }
    return { result: null, targetId: orderId, detail: { reason, close_event_id: closeEventId } };
  });
}

async function drainAfterClose() {
  // 이용권 회수가 바로 반영되게 한 번 드레인한다. 실패해도 DB 기록은 끝났고 다음 드레인에서 재시도된다.
  try {
    await runOutboxBatch();
  } catch (err) {
    console.error("환불 없는 종료 직후 아웃박스 드레인 실패(다음 드레인에서 재시도):", err);
  }
}

function revalidateClosed(orderIds: string[]) {
  for (const id of orderIds) revalidatePath(`/admin/orders/${id}`);
  revalidatePath("/admin/orders");
  revalidatePath("/admin/course-offerings");
  revalidatePath("/admin/course-offerings/[id]", "page");
  revalidatePath("/student");
}

export async function closeOrderWithoutRefund(
  orderId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) throw new UserFacingError("종료 사유를 입력해 주세요.");

    await closeOne(orderId, reason);
    await drainAfterClose();
    revalidateClosed([orderId]);
    return "환불 없이 수강을 종료했습니다. 결제 금액은 그대로이며 이용권은 회수됩니다.";
  });
}

/** 선택한 여러 학생을 한꺼번에 「환불 없이 종료」. 주문마다 같은 명령을 반복하고(주문마다 감사 1건) 건별 성공/실패를 모아 알린다. */
export async function bulkCloseOrders(
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    const orderIds = [...new Set(formData.getAll("orderId").map(String).filter(Boolean))];
    if (orderIds.length === 0) throw new UserFacingError("처리할 학생을 선택해 주세요.");
    if (!reason) throw new UserFacingError("종료 사유를 입력해 주세요.");

    const failures: string[] = [];
    let done = 0;
    for (const orderId of orderIds) {
      try {
        await closeOne(orderId, reason);
        done += 1;
      } catch (err) {
        failures.push(`${orderId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await drainAfterClose();
    revalidateClosed(orderIds);

    if (failures.length > 0) {
      return `${done}건 종료, ${failures.length}건 실패 — 실패한 건은 목록에 남아 있습니다. ${failures.join(" / ")}`;
    }
    return `${done}건을 환불 없이 종료했습니다. 결제 금액은 그대로이며 이용권은 회수됩니다.`;
  });
}

/**
 * ADMIN — 탈퇴 등으로 취소된 주문에 대해 「환불하지 않고 마무리」 결정.
 * 대사(미환불 탈퇴 주문 경고)를 해소하고 감사 사실(NO_REFUND_DECIDED)을 남긴다.
 */
export async function decideNoRefund(
  orderId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) throw new UserFacingError("마무리 결정 사유를 입력해 주세요.");

    await runCommand(
      { command: "ORDER_DECIDE_NO_REFUND", targetTable: "orders", target: { targetId: orderId } },
      async (actorProfile) => {
        const admin = createAdminClient();
        const { data: eventId, error } = await admin.rpc("decide_no_refund", {
          p_order_id: orderId,
          p_actor_id: actorProfile.id,
          p_actor_role: actorProfile.role,
          p_reason: reason,
        });
        if (error) {
          throw new UserFacingError(error.message);
        }
        return { result: null, targetId: orderId, detail: { reason, event_id: eventId } };
      },
    );

    revalidateClosed([orderId]);
    return "환불하지 않고 마무리로 처리했습니다.";
  });
}

