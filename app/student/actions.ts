"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { runCommand } from "@/lib/commands/run-command";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";
import { loadRefundProposal, summarizeProposal } from "@/lib/orders/refund-proposal";
import { refundBlockedMessage, studentProposalText } from "@/lib/shared/refund-request";
import { getRefundableAmount, requestRefund } from "@/lib/payment";
import { shouldAutoRefund } from "@/lib/payment/auto-refund-plan";

// 신청 취소(학생 본인): 소유권·상태·결제여부 검사와 이벤트 기록·좌석 반환을 전부
// DB 함수 `cancel_own_order()` 단일 트랜잭션으로 처리하여 동시성 경쟁 상태(중복 좌석 반환 등)를 원천 방지한다.
//
// 가드는 assertActive(탈퇴자 차단) 적용: 취소는 리소스를 반환하는 작업이므로 탈퇴하지 않은 계정이면 수행 가능하다.
// `runAction` 래퍼를 통해 DB 예외 메시지를 사용자 친화적인 결과로 안전하게 반환한다.
export async function cancelMyEnrollment(
  orderId: string,
  _prevState: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await runCommand(
      { command: "ORDER_CANCEL_SELF", targetTable: "orders" },
      async (actor) => {
        const admin = createAdminClient();
        const { error } = await admin.rpc("cancel_own_order", {
          p_order_id: orderId,
          p_user_id: actor.id,
        });

        if (error) {
          throw new UserFacingError(error.message);
        }
        return { result: null, targetId: orderId };
      },
    );

    revalidatePath("/student");
  });
}

// 수강생 환불 신청 — **신청만 한다.** 환불은 관리자가 검토해 기존 환불 버튼으로 따로 한다. 자동 환불은 없다.
//  · 소유·승인됨·결제완료·카드·열린 신청 없음·사유는 DB 함수(request_order_refund)가 최종 판정한다.
//  · 약관 기준 구간(자격)은 화면이 버튼을 켠 뒤에도 바뀔 수 있으므로(예: 자정을 넘겨 개강 당일이 됨) 여기서 같은 평가 함수로 **다시 계산**하고,
//    미달이면 안내 문구로 거절한다(자격 미달 팝업). 통과하면 그 계산 요약을 신청 사건에 사실로 남긴다(분쟁 시 「그날 안내받은 기준」의 근거).
export async function requestMyRefund(
  orderId: string,
  _prevState: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) throw new UserFacingError("환불 사유를 입력해 주세요.");

    const scheduleChangeNoticeId = String(formData.get("scheduleChangeNoticeId") ?? "").trim() || null;

    const text = await runCommand(
      { command: "ORDER_REFUND_REQUEST", targetTable: "order_events", target: { targetId: orderId } },
      async (actor) => {
        const admin = createAdminClient();

        // 남의 주문의 환불 구간을 엿보지 못하게 소유부터 확인한다(DB 함수도 다시 확인한다).
        const { data: orderData } = await admin
          .from("orders")
          .select("user_id, status, payment_status, payment_method, course_offering_id, course_offerings(auto_refund, status)")
          .eq("id", orderId)
          .maybeSingle();
        if (!orderData || orderData.user_id !== actor.id) throw new UserFacingError("내 신청 건이 아닙니다.");

        let proposal;
        try {
          proposal = await loadRefundProposal(orderId);
        } catch (err) {
          console.error("환불 신청 제안 계산 실패:", err);
          throw new UserFacingError("환불 기준을 확인하지 못했습니다. 관리자에게 문의해 주세요.");
        }
        if (!proposal) {
          throw new UserFacingError("환불 기준을 확인하지 못했습니다. 관리자에게 문의해 주세요.");
        }

        const proposalPayload = summarizeProposal(proposal) ?? {};
        if (scheduleChangeNoticeId) {
          (proposalPayload as Record<string, unknown>).context = {
            schedule_change_notice_event_id: scheduleChangeNoticeId,
            schedule_changed_since_order: true,
          };
        }

        const { data: eventId, error } = await admin.rpc("request_order_refund", {
          p_order_id: orderId,
          p_user_id: actor.id,
          p_reason: reason,
          p_proposal: proposalPayload,
        });
        if (error) throw new UserFacingError(error.message);

        // A-9: 자동 환불 옵션 판정 및 실행
        const offering = Array.isArray(orderData.course_offerings)
          ? orderData.course_offerings[0]
          : orderData.course_offerings;
        const autoRefundEnabled = offering?.auto_refund === true;
        const offeringStatus = offering?.status ?? null;

        const canAuto = shouldAutoRefund({
          offeringAutoRefund: autoRefundEnabled,
          proposal,
          order: {
            status: orderData.status,
            payment_status: orderData.payment_status,
            payment_method: orderData.payment_method,
          },
          offeringStatus,
        });

        let autoRefundDone = false;
        let autoRefundErrorText: string | null = null;

        if (canAuto) {
          try {
            await runCommand(
              {
                command: "PAYMENT_REFUND_AUTO",
                targetTable: "payment_events",
                target: { targetId: orderId },
              },
              async () => {
                const refundable = await getRefundableAmount(orderId);
                const reqAmount = proposal.amount >= refundable ? null : proposal.amount;
                const result = await requestRefund({
                  orderId,
                  amount: reqAmount,
                  reason: `자동 환불 — 학생 신청: ${reason}`,
                  requestKey: `auto:${eventId}`,
                  source: "AUTO",
                  studentRequestEventId: eventId,
                  actorId: actor.id,
                });
                if (result.result === "SUBMITTED") {
                  autoRefundDone = true;
                }
                return {
                  result: null,
                  targetId: orderId,
                  detail: {
                    auto: true,
                    studentRequestEventId: eventId,
                    proposal: proposalPayload,
                    amount: reqAmount,
                    outcome: result.result,
                  },
                };
              },
            );
          } catch (autoErr) {
            console.error("자동 환불 처리 실패 (대기열 이관):", autoErr);
            autoRefundErrorText = "자동 환불 처리에 실패하여 관리자 확인 대기열로 접수되었습니다.";
          }
        }

        let message: string;
        if (autoRefundDone) {
          message = [
            `약관 기준에 따라 ${proposal.amount.toLocaleString()}원 환불을 즉시 요청했습니다(PG 처리 중). 완료되면 수강이 종료됩니다.`,
            proposal ? studentProposalText(proposal) : "",
          ]
            .filter(Boolean)
            .join("\n");
        } else if (autoRefundErrorText) {
          message = [
            `환불이 신청되었습니다. ${autoRefundErrorText}`,
            proposal ? studentProposalText(proposal) : "",
          ]
            .filter(Boolean)
            .join("\n");
        } else {
          message = [
            "환불을 신청했습니다. 관리자가 검토한 뒤 처리합니다(자동으로 환불되지 않습니다).",
            proposal ? studentProposalText(proposal) : "",
          ]
            .filter(Boolean)
            .join("\n");
        }

        return { result: message, targetId: orderId, detail: { requestEventId: eventId, proposal: proposalPayload, autoRefundDone } };
      },
    );

    revalidatePath("/student");
    return text;
  });
}
