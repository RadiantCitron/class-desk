"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { one } from "@/lib/supabase/relations";
import { getRefundableAmount, requestRefund } from "@/lib/payment";
import {
  buildBulkRefundPreview,
  BULK_REFUND_MAX_STUDENTS,
  type BulkRefundMode,
  type BulkRefundPreviewResult,
  type BulkRefundPreviewInputRow,
} from "@/lib/payment/bulk-refund-plan";
import { loadRefundProposal, summarizeProposal } from "@/lib/orders/refund-proposal";
import { ordersWithOpenRefundRequest } from "@/lib/guards/offering-cancel-settled";
import { loadOpenRefundRequest } from "@/lib/orders/refund-request";
import { runCommand, runQuery } from "@/lib/commands/run-command";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";

// 선별·일괄 환불 (미리보기 -> 확인 -> 건별 실행).
// 폐강(CANCELLING)뿐만 아니라 일반 강의(OPEN, CLOSED 등) 모든 상태에서 선별 환불을 지원한다.
// 결제 모듈 호출과 주문 모듈 읽기를 진입점에서 조합하며, 단일 액션 = 단일 명령 원칙을 준수한다.

export type BulkRefundExecuteRow = {
  orderId: string;
  decidedAmount: number;
  rowReason: string;
  seenRefundable: number;
  seenProposalAmount: number;
};

export type BulkRefundExecutePayload = {
  batchId: string;
  refundCause: "STUDENT" | "OPERATOR"; // 학생 사정 vs 우리(운영) 사정
  commonReason: string;
  rows: BulkRefundExecuteRow[];
};

export type BulkRefundItemResult = {
  orderId: string;
  email: string;
  outcome: "REQUESTED" | "SKIPPED" | "FAILED";
  amount: number;
  message?: string;
};

export type BulkRefundExecuteResult = {
  batchId: string;
  requestedCount: number;
  failedCount: number;
  skippedCount: number;
  totalRequestedAmount: number;
  items: BulkRefundItemResult[];
  summaryMessage: string;
};

/**
 * 선별·일괄 환불 미리보기 (QUERY: ADMIN_BULK_REFUND_PREVIEW)
 */
export async function previewBulkRefund(
  offeringId: string,
  orderIds: string[],
  mode: BulkRefundMode,
  options?: { fixedAmount?: number },
): Promise<ActionResult<BulkRefundPreviewResult>> {
  return runAction(async () => {
    return runQuery({ command: "ADMIN_BULK_REFUND_PREVIEW" }, async () => {
      const distinctOrderIds = [...new Set(orderIds.filter(Boolean))];
      if (distinctOrderIds.length === 0) {
        throw new UserFacingError("처리할 학생을 선택해 주세요.");
      }
      if (distinctOrderIds.length > BULK_REFUND_MAX_STUDENTS) {
        throw new UserFacingError(
          `한 번에 최대 ${BULK_REFUND_MAX_STUDENTS}명까지만 처리할 수 있습니다. 나눠서 진행해 주세요(선택: ${distinctOrderIds.length}명).`,
        );
      }

      const admin = createAdminClient();
      const { data: offering, error: offeringError } = await admin
        .from("course_offerings")
        .select("id, status")
        .eq("id", offeringId)
        .maybeSingle();

      if (offeringError || !offering) {
        throw new UserFacingError("개설강의를 찾을 수 없습니다.");
      }

      const { data: orderRows, error: orderError } = await admin
        .from("orders")
        .select("id, status, payment_status, payment_method, final_amount, refunded_amount, users(email, name)")
        .eq("course_offering_id", offeringId)
        .in("id", distinctOrderIds);

      if (orderError) {
        throw new UserFacingError(`주문 조회 실패: ${orderError.message}`);
      }

      const orders = orderRows ?? [];
      const byId = new Map(orders.map((o) => [o.id, o]));
      const openRefundSet = await ordersWithOpenRefundRequest(distinctOrderIds);

      const previewInputRows: BulkRefundPreviewInputRow[] = [];

      for (const orderId of distinctOrderIds) {
        const order = byId.get(orderId);
        if (!order) {
          throw new UserFacingError(`선택한 주문(${orderId.slice(0, 8)})이 이 개설강의에 속하지 않습니다.`);
        }

        const user = one(order.users);
        const email = user?.email ?? "-";
        const name = user?.name ?? null;
        const paidAmount = order.final_amount ?? 0;
        const refundedAmount = order.refunded_amount ?? 0;
        const refundableAmount = await getRefundableAmount(orderId);

        let proposalAmount: number | null = null;
        let proposalReason = "";

        try {
          const proposal = await loadRefundProposal(orderId, refundableAmount);
          if (proposal) {
            proposalAmount = proposal.amount;
            proposalReason = `${proposal.headline} · ${proposal.detail}`;
          } else {
            proposalAmount = null;
            proposalReason = "약관 환불 제안 대상 아님";
          }
        } catch (err) {
          proposalAmount = null;
          proposalReason = err instanceof Error ? err.message : "약관 제안 계산 실패";
        }

        // 출석 데이터 미존재 고지 문구 부착
        if (proposalReason) {
          proposalReason += " (지난 회차는 강의 단위로 센 것이며 개인 출석이 아닙니다)";
        }

        previewInputRows.push({
          orderId,
          email,
          name,
          paidAmount,
          refundedAmount,
          refundableAmount,
          proposalAmount,
          proposalReason,
          hasOpenRefundRequest: openRefundSet.has(orderId),
          order: {
            status: order.status,
            payment_status: order.payment_status,
            payment_method: order.payment_method,
          },
        });
      }

      const batchId = randomUUID();
      const preview = buildBulkRefundPreview(previewInputRows, mode, {
        fixedAmount: options?.fixedAmount,
        batchId,
      });

      if (!preview.ok) {
        throw new UserFacingError(preview.error);
      }

      return preview;
    });
  });
}

/**
 * 선별·일괄 환불 실행 (건별 PAYMENT_REFUND_REQUEST)
 */
export async function executeBulkRefund(
  offeringId: string,
  payload: BulkRefundExecutePayload,
): Promise<ActionResult<BulkRefundExecuteResult>> {
  return runAction(async () => {
    const { batchId, refundCause, commonReason, rows } = payload;
    const trimmedCommonReason = commonReason.trim();

    if (!batchId) {
      throw new UserFacingError("배치 ID가 누락되었습니다. 미리보기를 다시 진행해 주세요.");
    }
    if (!trimmedCommonReason) {
      throw new UserFacingError("공통 환불 사유를 입력해 주세요.");
    }
    if (!rows || rows.length === 0) {
      throw new UserFacingError("환불할 대상이 선택되지 않았습니다.");
    }
    if (rows.length > BULK_REFUND_MAX_STUDENTS) {
      throw new UserFacingError(
        `한 번에 최대 ${BULK_REFUND_MAX_STUDENTS}명까지만 처리할 수 있습니다. 나눠서 진행해 주세요(현재 ${rows.length}명).`,
      );
    }

    const admin = createAdminClient();

    // 1. batchId 중복 실행 검사
    const { data: existingBatchEvent } = await admin
      .from("payment_events")
      .select("id")
      .contains("metadata", { batch_id: batchId })
      .limit(1)
      .maybeSingle();

    if (existingBatchEvent) {
      throw new UserFacingError(
        "이미 처리되었거나 처리 중인 일괄 환불 요청입니다(중복 제출 방지). 새로고침 후 확인해 주세요.",
      );
    }

    // 개설강의 상태 확인 (출처 판정용)
    const { data: offering, error: offeringError } = await admin
      .from("course_offerings")
      .select("id, status")
      .eq("id", offeringId)
      .maybeSingle();

    if (offeringError || !offering) {
      throw new UserFacingError("개설강의를 찾을 수 없습니다.");
    }

    const isCancelling = offering.status === "CANCELLING";
    const source = isCancelling ? "OFFERING_CANCEL" : "ADMIN";
    const operatorCause = isCancelling ? false : refundCause === "OPERATOR";

    const distinctOrderIds = [...new Set(rows.map((r) => r.orderId))];
    const { data: orderRows, error: orderError } = await admin
      .from("orders")
      .select("id, status, payment_status, payment_method, final_amount, refunded_amount, users(email)")
      .eq("course_offering_id", offeringId)
      .in("id", distinctOrderIds);

    if (orderError) {
      throw new UserFacingError(`주문 조회 실패: ${orderError.message}`);
    }

    const orders = orderRows ?? [];
    const byId = new Map(orders.map((o) => [o.id, o]));
    const openRefundSet = await ordersWithOpenRefundRequest(distinctOrderIds);

    // 2. 서버 재계산 및 「본 값」 불신 검증 (Anti-pattern 6: 화면 값 불일치 시 전체 거부)
    for (const row of rows) {
      const order = byId.get(row.orderId);
      if (!order) {
        throw new UserFacingError("주문 목록이 변경되었습니다. 미리보기를 다시 진행해 주세요.");
      }
      if (openRefundSet.has(row.orderId)) {
        throw new UserFacingError("이미 환불 요청이 진행 중인 주문이 포함되어 있습니다. 미리보기를 다시 진행해 주세요.");
      }

      const currentRefundable = await getRefundableAmount(row.orderId);
      if (currentRefundable !== row.seenRefundable) {
        throw new UserFacingError(
          `환불 가능액이 변경된 학생이 있습니다(${row.orderId.slice(0, 8)}: ${row.seenRefundable.toLocaleString()}원 -> ${currentRefundable.toLocaleString()}원). 미리보기를 다시 진행해 주세요.`,
        );
      }

      const proposal = await loadRefundProposal(row.orderId, currentRefundable);
      const currentProposalAmount = proposal?.amount ?? 0;
      if (currentProposalAmount !== row.seenProposalAmount) {
        throw new UserFacingError(
          `약관 제안액이 변경된 학생이 있습니다(${row.orderId.slice(0, 8)}). 미리보기를 다시 진행해 주세요.`,
        );
      }

      // 결정액이 제안액과 다르면 행 사유 필수 검증
      if (row.decidedAmount !== currentProposalAmount && !row.rowReason.trim()) {
        throw new UserFacingError(
          `약관 제안액과 다른 결정액이 설정된 건(${row.orderId.slice(0, 8)})에는 행 사유가 필수입니다.`,
        );
      }
      if (row.decidedAmount > currentRefundable) {
        throw new UserFacingError(
          `결정액이 환불 가능액을 초과할 수 없습니다(${row.orderId.slice(0, 8)}: 가능액 ${currentRefundable.toLocaleString()}원).`,
        );
      }
      if (row.decidedAmount <= 0) {
        throw new UserFacingError(`환불 결정액은 0원보다 커야 합니다(${row.orderId.slice(0, 8)}).`);
      }
    }

    // 3. 건별 독립 실행 (PAYMENT_REFUND_REQUEST)
    const items: BulkRefundItemResult[] = [];
    let requestedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let totalRequestedAmount = 0;

    const totalBatchAmount = rows.reduce((sum, r) => sum + r.decidedAmount, 0);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const order = byId.get(row.orderId)!;
      const user = one(order.users);
      const email = user?.email ?? "-";

      const fullReason = row.rowReason.trim()
        ? `[공통: ${trimmedCommonReason}] ${row.rowReason.trim()}`
        : trimmedCommonReason;

      let studentRequestEventId: string | null = null;
      try {
        const openStudentReq = await loadOpenRefundRequest(row.orderId);
        if (openStudentReq) {
          studentRequestEventId = openStudentReq.id;
        }
      } catch {
        studentRequestEventId = null;
      }

      try {
        const proposal = await loadRefundProposal(row.orderId, row.seenRefundable);
        const proposalSummary = summarizeProposal(proposal);
        const deviates = row.decidedAmount !== (proposal?.amount ?? 0);

        const outcome = await runCommand(
          {
            command: "PAYMENT_REFUND_REQUEST",
            targetTable: "payment_events",
            target: { targetId: row.orderId },
          },
          async (adminProfile) => {
            const result = await requestRefund({
              orderId: row.orderId,
              amount: row.decidedAmount,
              reason: fullReason,
              requestKey: randomUUID(),
              source,
              batchId,
              operatorCause,
              studentRequestEventId,
              actorId: adminProfile.id,
            });

            return {
              result: result.result,
              targetId: row.orderId,
              detail: {
                reason: fullReason,
                mode: "bulk-preview",
                batchId,
                batchSize: rows.length,
                batchTotal: totalBatchAmount,
                position: i + 1,
                amount: row.decidedAmount,
                proposal: proposalSummary,
                seenRefundable: row.seenRefundable,
                deviatesFromProposal: deviates,
                studentRequestEventId,
                operatorCause,
                outcome: result.result,
              },
            };
          },
        );

        if (outcome === "NOTHING_TO_REFUND") {
          skippedCount++;
          items.push({
            orderId: row.orderId,
            email,
            outcome: "SKIPPED",
            amount: 0,
            message: "환불할 잔액이 없습니다.",
          });
        } else if (outcome === "ALREADY_IN_PROGRESS") {
          skippedCount++;
          items.push({
            orderId: row.orderId,
            email,
            outcome: "SKIPPED",
            amount: 0,
            message: "이미 환불 요청이 진행 중입니다(웹훅 대기).",
          });
        } else {
          requestedCount++;
          totalRequestedAmount += row.decidedAmount;
          items.push({
            orderId: row.orderId,
            email,
            outcome: "REQUESTED",
            amount: row.decidedAmount,
          });
        }
      } catch (err) {
        failedCount++;
        items.push({
          orderId: row.orderId,
          email,
          outcome: "FAILED",
          amount: row.decidedAmount,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    revalidatePath(`/admin/course-offerings/${offeringId}`);
    revalidatePath("/admin/course-offerings");
    revalidatePath("/admin/payments");
    for (const row of rows) {
      revalidatePath(`/admin/orders/${row.orderId}`);
    }

    const summaryParts: string[] = [
      `${requestedCount}건 환불 요청 완료 (${totalRequestedAmount.toLocaleString()}원)`,
    ];
    if (skippedCount > 0) summaryParts.push(`${skippedCount}건 건너뜀`);
    if (failedCount > 0) summaryParts.push(`${failedCount}건 실패`);

    return {
      batchId,
      requestedCount,
      failedCount,
      skippedCount,
      totalRequestedAmount,
      items,
      summaryMessage: summaryParts.join(" / "),
    };
  });
}
