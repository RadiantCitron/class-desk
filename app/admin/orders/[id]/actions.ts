"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import {
  confirmPayment,
  getRefundableAmount,
  markRefundRequestFailed,
  requestRefund,
} from "@/lib/payment";
import { hasConsumedDigitalProduct } from "@/lib/guards/digital-refund";
import { loadRefundProposal, readRequestSnapshot, summarizeProposal } from "@/lib/orders/refund-proposal";
import { loadOpenRefundRequest } from "@/lib/orders/refund-request";

import { loadScheduleChangeState } from "@/lib/orders/schedule-change";
import { canExcludeForScheduleChange } from "@/lib/shared/schedule-change";
import { createAdminClient } from "@/lib/supabase/admin";
import { runOutboxBatch } from "@/lib/wiring/outbox";
import { runCommand } from "@/lib/commands/run-command";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";

// 관리자 수동 결제 확정(R1 해소). orders.payment_status를 직접 UPDATE하지
// 않는다 — confirmPayment()(record_payment_event RPC)를 provider='MANUAL'로 호출해 웹훅과
// 같은 경로(on_payment_succeeded → 아웃박스 → 이용권)를 탄다. ADMIN 전용(D1, 매니저 위임
// 없음). 실패/취소 마무리는 다루지 않는다.
export async function confirmPaymentManually(
  orderId: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      throw new UserFacingError("확정 사유를 입력해 주세요.");
    }

    await runCommand({ command: "PAYMENT_CONFIRM_MANUAL", targetTable: "payment_events", target: { targetId: orderId } }, async (adminProfile) => {
      const supabase = await createClient();
      const { data: order, error: orderError } = await supabase
        .from("orders")
        .select("id, payment_status, final_amount")
        .eq("id", orderId)
        .maybeSingle();

      if (orderError || !order) {
        throw new Error(`주문 조회 실패: ${orderError?.message ?? "not found"}`);
      }
      if (order.payment_status !== "UNPAID") {
        throw new UserFacingError(`이미 처리된 결제 건입니다(현재 상태: ${order.payment_status}).`);
      }

      const { recorded } = await confirmPayment({
        provider: "MANUAL",
        providerEventId: `manual-confirm:${orderId}`,
        eventType: "PAYMENT_SUCCEEDED",
        amount: order.final_amount!,
        currency: "KRW",
        orderId,
        // PAID는 payment_method가 not null이어야 한다(orders_payment_consistency).
        // 수동 확정의 실제 경우는 계좌이체다.
        paymentMethod: "BANK_TRANSFER",
        metadata: { reason },
        raw: { manual: true, reason, actor_profile_id: adminProfile.id },
      });

      if (!recorded) {
        throw new UserFacingError("이미 확정된 결제입니다.");
      }

      // 웹훅 라우트(app/api/webhooks/payment/route.ts)와 같은 이유로 즉시 한 번 드레인해
      // 이용권 지급이 다음 크론까지 기다리지 않게 한다. 실패해도 원장 기록은 이미 끝났다.
      try {
        await runOutboxBatch();
      } catch (err) {
        console.error("수동 결제 확정 직후 아웃박스 드레인 실패(다음 드레인에서 재시도):", err);
      }

      return { result: null, targetId: orderId, detail: { reason, provider: "MANUAL" } };
    });

    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath("/admin/orders");
    revalidatePath("/admin/payments");
  });
}

function revalidateOrder(orderId: string) {
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  revalidatePath("/admin/payments");
}

/** ADMIN 환불 개시. 전액=amount 빈칸·"full", 부분=금액. */
export async function requestOrderRefund(
  orderId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    const requestKey = String(formData.get("requestKey") ?? "").trim();
    const mode = String(formData.get("mode") ?? "full");
    const partialRaw = String(formData.get("partialAmount") ?? "").trim();
    const keepOrder = String(formData.get("keepOrder") ?? "").trim() === "true" || formData.get("keepOrder") === "on";

    if (!reason) throw new UserFacingError("환불 사유를 입력해 주세요.");
    if (!requestKey) throw new UserFacingError("요청 키가 없습니다. 새로고침 후 다시 시도하세요.");

    let amount: number | null = null;
    if (mode === "partial") {
      const n = Number(partialRaw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new UserFacingError("부분 환불 금액을 양의 정수(원)로 입력해 주세요.");
      }
      amount = n;
    }

    const message = await runCommand(
      { command: "PAYMENT_REFUND_REQUEST", targetTable: "payment_events", target: { targetId: orderId } },
      async (adminProfile) => {
        // 다운로드 이력은 환불을 막지 않는다 — 판단은 관리자, 근거는 감사 기록(2026-10-07. 10-04 R-5 차단 철회).
        const digitalConsumed = await hasConsumedDigitalProduct(orderId);

        const refundable = await getRefundableAmount(orderId);
        if (refundable <= 0) {
          throw new UserFacingError("환불할 잔액이 없습니다.");
        }
        if (amount != null && amount > refundable) {
          throw new UserFacingError(`환불 가능액은 ${refundable.toLocaleString()}원입니다.`);
        }

        // 감사에 「그때의 약관 기준 제안」을 같이 남긴다(제안과 실제 금액이 다를 때의 근거, ADR-0025). 제안 계산이 실패해도 환불은 막지 않는다.
        let proposalSummary: ReturnType<typeof summarizeProposal> = null;
        try {
          proposalSummary = summarizeProposal(await loadRefundProposal(orderId, refundable));
        } catch (err) {
          proposalSummary = summarizeProposal(null, err instanceof Error ? err.message : String(err));
        }

        // 학생이 환불을 신청한 주문이면 그 신청을 환불 요청에 연결한다 — 환불 원인이 STUDENT_REFUND가 된다.
        // 또한 신청 시점 제안 스냅샷을 읽어 감사 기록에 남긴다.
        let studentRequestEventId: string | null = null;
        let requestSnapshotAmount: number | null = null;
        try {
          const openReq = await loadOpenRefundRequest(orderId);
          if (openReq) {
            studentRequestEventId = openReq.id;
            const snapshot = readRequestSnapshot(openReq.payload);
            if (snapshot?.proposal && typeof snapshot.proposal.amount === "number") {
              requestSnapshotAmount = snapshot.proposal.amount;
            }
          }
        } catch {
          studentRequestEventId = null;
          requestSnapshotAmount = null;
        }

        const decidedAmount = amount ?? refundable;
        const deviatesFromSnapshot =
          requestSnapshotAmount !== null ? decidedAmount !== requestSnapshotAmount : false;

        // 종결된 주문(CANCELLED) 사후 환불인지 서버에서 재판정한다(ADR-0029).
        const admin = createAdminClient();
        const { data: ord } = await admin
          .from("orders")
          .select("status")
          .eq("id", orderId)
          .maybeSingle();
        const postClose = ord?.status === "CANCELLED";

        let result;
        try {
          result = await requestRefund({
            orderId,
            amount,
            reason,
            requestKey,
            source: "ADMIN",
            studentRequestEventId,
            postClose,
            actorId: adminProfile.id,
            keepOrder,
          });
        } catch (err) {
          // 결과 불명 — 관리자에게 문구를 그대로 보여 준다.
          if (
            err instanceof Error &&
            err.message.includes("다시 누르지 마세요")
          ) {
            throw new UserFacingError(err.message);
          }
          throw err;
        }

        const text =
          result.result === "SUBMITTED"
            ? "환불 요청됨(PG 처리 중)"
            : result.result === "ALREADY_IN_PROGRESS"
              ? "이미 환불 요청이 진행 중입니다(웹훅 대기)"
              : "환불할 잔액이 없습니다";

        return {
          result: text,
          targetId: orderId,
          detail: {
            reason,
            requestKey,
            mode,
            amount,
            outcome: result.result,
            digitalConsumed,
            proposal: proposalSummary,
            requestedAmount: decidedAmount,
            studentRequestEventId,
            requestSnapshotAmount,
            decidedAmount,
            deviatesFromSnapshot,
          },
        };
      },
    );

    revalidateOrder(orderId);

    return message;
  });
}

/**
 * ADMIN — 수강생의 환불 신청 거절. 사유 필수, 열린 신청이 있을 때만(DB 함수가 최종 판정). 거절해도 직권 환불은 막지 않는다.
 * 메일·알림은 보내지 않는다 — 학생은 홈 화면에서 거절 사유를 본다.
 */
export async function rejectOrderRefundRequest(
  orderId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) throw new UserFacingError("거절 사유를 입력해 주세요.");

    await runCommand({ command: "ORDER_REFUND_REJECT", targetTable: "order_events", target: { targetId: orderId } }, async (adminProfile) => {
      const admin = createAdminClient();
      const { data, error } = await admin.rpc("reject_order_refund_request", {
        p_order_id: orderId,
        p_actor_id: adminProfile.id,
        p_actor_role: adminProfile.role,
        p_reason: reason,
      });
      if (error) throw new UserFacingError(error.message);
      return { result: null, targetId: orderId, detail: { reason, rejectEventId: data } };
    });

    revalidateOrder(orderId);
    return "환불 신청을 거절했습니다. 수강생은 홈 화면에서 거절 사유를 볼 수 있고 다시 신청할 수 있습니다.";
  });
}

/**
 * ADMIN — 일정 변경 후 미결제·무료(직권 부여) 수강생을 수업에서 제외.
 *  · 결제 완료 건: 상단의 「선별 일괄 환불」을 통해 약관 제안을 확인하고 환불 처리합니다.
 *  · 미결제·무료 건: 환불 없이 제외 처리하며, 좌석이 반환되고 이용권·역할이 회수됩니다.
 */
export async function excludeOrderForScheduleChange(
  orderId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const memo = String(formData.get("memo") ?? "").trim();

    return runCommand({ command: "ORDER_SCHEDULE_CHANGE_EXCLUDE", targetTable: "orders", target: { targetId: orderId } }, async (adminProfile) => {
      const info = await loadScheduleChangeState(orderId);
      if (!info || !canExcludeForScheduleChange(info.state)) {
        throw new UserFacingError("일정 변경 안내가 전달된 미결제·무료 신청 건만 제외 처리할 수 있습니다. 화면을 새로고침해 주세요.");
      }
      const paid = info.paymentStatus === "PAID" || info.paymentStatus === "PARTIALLY_REFUNDED";
      if (paid) {
        throw new UserFacingError("결제 완료 건은 개설강의 상세의 「선별 일괄 환불」에서 약관 제안 금액을 확인하고 환불 처리해 주세요.");
      }

      const state = info.state!;
      const why = "일정 변경으로 인한 수업 제외";
      const reason = memo ? `${why} — ${memo}` : why;

      const admin = createAdminClient();
      const { data, error } = await admin.rpc("exclude_order_for_schedule_change", {
        p_order_id: orderId,
        p_actor_id: adminProfile.id,
        p_actor_role: adminProfile.role,
        p_reason: reason,
      });
      if (error) throw new UserFacingError(error.message);
      try {
        await runOutboxBatch();
      } catch (err) {
        console.error("일정 변경 제외 직후 아웃박스 드레인 실패:", err);
      }
      revalidateOrder(orderId);
      return { result: "수업에서 제외했습니다(미결제·무료 건). 이용권·디스코드 역할은 회수됩니다.", targetId: orderId, detail: { reason, closeEventId: data, noticeEventId: state.noticeId, mode: "NO_REFUND" } };
    });
  });
}

/** ADMIN — 열린 요청을 실패로 표시(D15(6)). */
export async function markOrderRefundRequestFailed(
  orderId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) throw new UserFacingError("사유를 입력해 주세요.");

    await runCommand({ command: "PAYMENT_REFUND_MARK_FAILED", targetTable: "payment_events", target: { targetId: orderId } }, async () => {
      await markRefundRequestFailed(orderId, reason);
      return { result: null, targetId: orderId, detail: { reason } };
    });

    revalidateOrder(orderId);
    return "환불 요청을 실패로 표시했습니다. 새 요청을 할 수 있습니다.";
  });
}

/**
 * ADMIN — PG 외 환불 반영(D17b).
 * 열린 요청이 있으면 키 `manual-refund:{requestEventId}`, 없으면 `manual-refund:{formKey}`.
 */
export async function confirmManualRefund(
  orderId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    const openRequestId = String(formData.get("openRequestId") ?? "").trim();
    const openRequestAmount = String(formData.get("openRequestAmount") ?? "").trim();
    const formKey = String(formData.get("formKey") ?? "").trim() || randomUUID();
    const amountRaw = String(formData.get("amount") ?? "").trim();
    const keepOrder = String(formData.get("keepOrder") ?? "").trim() === "true" || formData.get("keepOrder") === "on";

    if (!reason) throw new UserFacingError("사유를 입력해 주세요.");

    let amount: number;
    if (openRequestId) {
      amount = Number(openRequestAmount);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new UserFacingError("열린 요청 금액이 올바르지 않습니다.");
      }
    } else {
      amount = Number(amountRaw);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new UserFacingError("환불 금액을 양의 정수(원)로 입력해 주세요.");
      }
    }

    // R-4(2026-10-02): 환불 수단은 관리자가 고른다. "ORIGINAL"은 주문에 기록된 원결제 수단을 따른다.
    const refundMethodRaw = String(formData.get("refundMethod") ?? "").trim();
    if (!["ORIGINAL", "BANK_TRANSFER", "OTHER"].includes(refundMethodRaw)) {
      throw new UserFacingError("환불 수단을 선택해 주세요.");
    }

    const providerEventId = openRequestId
      ? `manual-refund:${openRequestId}`
      : `manual-refund:${formKey}`;

    const message = await runCommand(
      { command: "PAYMENT_REFUND_MANUAL", targetTable: "payment_events", target: { targetId: orderId } },
      async (adminProfile) => {
        // PG 외 환불 반영은 이미 일어난 사실을 장부에 적는 것이라 다운로드 이력으로 막지 않는다. 기록만 남긴다.
        const digitalConsumed = await hasConsumedDigitalProduct(orderId);

        let paymentMethod: "CARD" | "BANK_TRANSFER" | "OTHER";
        if (refundMethodRaw === "ORIGINAL") {
          const supabase = await createClient();
          const { data: order } = await supabase
            .from("orders")
            .select("payment_method")
            .eq("id", orderId)
            .maybeSingle();
          const original = order?.payment_method;
          if (original !== "CARD" && original !== "BANK_TRANSFER" && original !== "OTHER") {
            throw new UserFacingError(
              "원결제 수단이 기록돼 있지 않습니다. 계좌이체 또는 기타를 선택해 주세요.",
            );
          }
          paymentMethod = original;
        } else {
          paymentMethod = refundMethodRaw as "BANK_TRANSFER" | "OTHER";
        }

        const supabase = await createClient();
        const { data: ord } = await supabase
          .from("orders")
          .select("status")
          .eq("id", orderId)
          .maybeSingle();
        const postClose = ord?.status === "CANCELLED";

        const { recorded } = await confirmPayment({
          provider: "MANUAL",
          providerEventId,
          eventType: "REFUNDED",
          amount,
          currency: "KRW",
          orderId,
          paymentMethod,
          metadata: {
            reason,
            source: "ADMIN_MANUAL_REFUND",
            refundMethod: refundMethodRaw,
            ...(postClose ? { post_close: true } : {}),
            ...(keepOrder ? { keep_order: true } : {}),
          },
          raw: {
            manual: true,
            reason,
            actor_profile_id: adminProfile.id,
            open_request_id: openRequestId || null,
          },
        });

        if (!recorded) {
          throw new UserFacingError("이미 반영된 PG 외 환불입니다.");
        }

        try {
          await runOutboxBatch();
        } catch (err) {
          console.error("PG 외 환불 반영 직후 아웃박스 드레인 실패:", err);
        }

        return {
          result: "PG 외 환불을 원장에 반영했습니다.",
          targetId: orderId,
          detail: { reason, providerEventId, amount, paymentMethod, digitalConsumed },
        };
      },
    );

    revalidateOrder(orderId);
    return message;
  });
}
