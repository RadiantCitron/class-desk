"use server";

import { startCheckout } from "@/lib/payment";
import { runCommand } from "@/lib/commands/run-command";
import { assertCheckoutEligible } from "@/lib/guards/checkout";
import { assertTermsAgreed } from "@/lib/guards/terms";
import { runAction, type ActionResult } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";

// 2중 방어의 두 번째 관문: 결제 페이지를 렌더링할 때 이미 한 번 자격을 확인했지만(1차, UX용),
// 사용자가 결제창에서 "결제하기"를 실제로 누른 이 시점에 같은 규칙을 다시 통과해야만 결제 시도가 생성된다(2차, TOCTOU 방어).
// 자격 검증은 가드(`lib/guards/checkout`)가 전담하고, 결제 모듈(`startCheckout`)은 원장 기록 및 PG 연동만 담당한다.
// `runAction` 래퍼를 통해 예외 상황 시 사용자 친화적인 안내 메시지를 안전하게 전달한다.
//
// 중간 이동 페이지(/pg/toss/launch)를 없애면서 이 액션은 redirect하지 않고 결제 시작 값을 돌려준다.
// 결제 페이지의 브라우저 코드(TossPayment.tsx)가 SDK로 결제창을 열고, 사용자가 결제창의 "결제하기"를 누른 시점에 이 액션을 부른다.
export type StartPaymentData = {
  checkoutUrl: string | null; // 결제창 주소를 직접 주는 PG용 골격 — 지금은 항상 null이고 받는 화면이 없다
  clientParams: Record<string, string> | null; // SDK로 여는 PG(토스)용 호출 값
};

export async function startPayment(orderId: string): Promise<ActionResult<StartPaymentData>> {
  return runAction(async () =>
    runCommand(
      {
        command: "PAYMENT_START",
        // 결제 시작은 원장(payment_events)이 아니라 결제 요청(payment_attempts)에 쓴다.
        targetTable: "payment_attempts",
        target: { targetId: orderId },
        guard: async (actor) => {
          const supabase = await createClient();
          await assertTermsAgreed(actor);
          return assertCheckoutEligible(orderId, actor.id);
        },
      },
      async (actor, ctx) => ({
        result: await startCheckout({
          orderId,
          amount: ctx.order.finalAmount!,
          buyerName: ctx.user.name,
        }),
        targetId: orderId,
      }),
    ),
  );
}
