import { redirect } from "next/navigation";
import { completeCheckout } from "@/lib/payment";
import { runCommand } from "@/lib/commands/run-command";
import { assertCheckoutEligibleForReturn } from "@/lib/guards/checkout";
import { runAction } from "@/lib/errors";
import { runOutboxBatch } from "@/lib/wiring/outbox";
import { returnDestination, type ReturnOutcome } from "../return-result";

// PG 결제창에서 successUrl/returnUrl로 복귀하는 Route Handler.
// 성공 → 수강 조회(/student?paid=1), 취소 → 결제 페이지(안내 없음), 그 외 → 결제 페이지(?from=return&r=결과).
// 결제 페이지가 원장으로 결과를 짐작하지 않게 이번 복귀의 결과(실패·승인 전 거부·확인 중·오류)를 r로 넘긴다(return-result.ts).
export async function GET(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await params;
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const attemptId = typeof query.attempt === "string" ? query.attempt : null;

  // 예상 못 한 예외(승인 응답 시간 초과 등)는 승인 요청 전인지 후인지 모른다 — error로 넘겨 "다시 결제하지 말라"고 안내한다.
  let threw = false;
  const outcome = await runAction(async () =>
    runCommand(
      {
        command: "PAYMENT_CONFIRM",
        targetTable: "payment_events",
        guard: async (actor) => {
          return assertCheckoutEligibleForReturn(orderId, actor.id, attemptId);
        },
      },
      async (_actor, ctx) => ({
        result: await completeCheckout(
          ctx.providerName,
          query,
          ctx.order.finalAmount!,
          orderId,
          ctx.attemptId,
        ),
        targetId: orderId,
      }),
    ),
  ).catch((err) => {
    threw = true;
    // F-15: 이중 로그 제거 — catch 한 곳에서만 남긴다.
    console.error("결제 복귀 처리 실패(주문조회 화면에서 원장 대조로 안내):", err);
  });

  const result: ReturnOutcome =
    threw || !outcome
      ? { kind: "threw" }
      : !outcome.ok
        ? { kind: "denied" }
        : { kind: "done", status: outcome.data.status };

  // 가드가 거부했으면(UserFacingError → ok:false) 승인을 부르지 않았다 — 서버 로그에 사유를 남긴다(2026-10-02 RLS 누락 사고 때 로그가 비어 원인 파악이 늦었다).
  if (outcome && !outcome.ok) {
    console.error("결제 복귀 거부(승인 호출 전):", outcome.message);
  }

  // 사용자 취소는 원장 기록이 없어 드레인할 것도 없다. 그 밖엔 이용권 지급 등 후속 처리를 한 번 돌린다.
  if (!(result.kind === "done" && result.status === "CANCELED")) {
    try {
      await runOutboxBatch();
    } catch (err) {
      console.error("복귀 직후 아웃박스 드레인 실패(다음 드레인에서 재시도):", err);
    }
  }

  redirect(returnDestination(orderId, result));
}
