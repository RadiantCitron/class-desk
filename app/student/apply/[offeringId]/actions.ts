"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequiredTermsForOffering, TERMS_TYPE_LABELS } from "@/lib/terms";
import { runCommand } from "@/lib/commands/run-command";
import { assertTermsAgreed } from "@/lib/guards/terms";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";
import { CURRENT_REFUND_POLICY_ID } from "@/lib/shared/refund-policy";

// 신청을 사이트 내부 자체 폼으로 처리한다(Tally 외부 폼 철거).
// 좌석예약+신청기록+약관동의를 create_order() 단일 DB 트랜잭션으로 묶는다
// (supabase/migrations/20260911170000_conditional_terms.sql) — 기존 Tally 웹훅은 비동기라
// 실패 시 좌석을 수동으로 되돌려야 했지만, 자체 폼은 요청-응답이 동기라 그 문제가 사라진다.
//
// 2026-09-11 "약관 체계" 확장: PRIVACY_USE 하나만 보던 것에서, 그 개설강의가 요구하는 조건부
// 약관(THIRD_PARTY_SHARE/AI_CROSS_BORDER_TRANSFER/SOFTWARE_LICENSE_USE 등)까지 전부 동의
// 여부를 확인·기록하도록 확장했다(lib/terms.ts의 getRequiredTermsForOffering()).
//
// offeringId를 먼저 bind하므로 (prevState, formData)가 실제로는
// useActionState가 넘기는 인자다 — ActionForm(components/ActionForm.tsx)과 짝이다. 이
// RPC(create_order)가 던지는 예외는 전부 사용자에게 보여주려고 만든 한국어 문장이라
// (이미 신청한 강의입니다/정원이 마감되어...) 그대로 UserFacingError로 옮긴다.
export async function applyForOffering(
  offeringId: string,
  _prevState: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await runCommand(
      {
        command: "ORDER_APPLY",
        targetTable: "orders",
        // 수강 신청 제한·봉쇄는 명령 레일이 이 명령 앞에서 본다.
        // F-5: 디스코드 미연결이어도 수강 신청은 허용한다(신청 게이트 폐지).
        // 결제 시작 및 복귀 확정 직전(UNPAID)에서만 디스코드 연결을 필수로 확인한다.
        guard: async (actor) => {
          // [Zero-Trust] 전역 약관 미동의 시 차단
          await assertTermsAgreed(actor);
        },
      },
      async (actor) => {
        const supabase = await createClient();
        // 이 파일은 진입점(ENTRY)이라 주문 모듈 테이블을 읽어도 된다.
        // lib/terms.ts(회원 모듈)가 직접 읽지 않도록 여기서 조회해 배열로 넘긴다.
        const { data: offering } = await supabase
          .from("course_offerings")
          .select("required_terms_types")
          .eq("id", offeringId)
          .maybeSingle();
        const requiredTerms = await getRequiredTermsForOffering(
          supabase,
          actor.id,
          (offering?.required_terms_types as string[]) ?? [],
        );

        const missingContent = requiredTerms.filter((item) => !item.terms);
        if (missingContent.length > 0) {
          const labels = missingContent.map((item) => TERMS_TYPE_LABELS[item.type] ?? item.type).join(", ");
          throw new UserFacingError(`등록된 약관을 찾을 수 없습니다(${labels}). 관리자에게 문의해 주세요.`);
        }

        const termsIdsToAgree = requiredTerms
          .filter((item) => item.terms && !item.alreadyAgreed)
          .map((item) => {
            // [Zero-Trust] 폼 데이터에서 사용자의 명시적 체크를 파싱 및 검증
            if (_formData.get(`terms_${item.type}`) !== "on") {
              throw new UserFacingError(`${TERMS_TYPE_LABELS[item.type] ?? item.type} 약관에 동의해야 신청할 수 있습니다.`);
            }
            return item.terms!.id;
          });

        const admin = createAdminClient();
        // p_user_id는 public.users.id(=actor.id)다 — auth.users.id를 넣으면 안 된다
        // (2026-09-12 식별자 분리).
        // apply_for_offering()은 5단계(물품 추가, 2026-09-23)에서 create_order()로 바뀌었다 —
        // 수업·상품 둘 다 받는 함수라 강의 번호와 상품 번호 중 하나만 채운다(여긴 항상 강의).
        const { data: orderId, error } = await admin.rpc("create_order", {
          p_user_id: actor.id,
          p_course_offering_id: offeringId,
          p_product_id: null,
          p_terms_ids: termsIdsToAgree,
          // 주문을 만드는 시점의 환불 정책 버전을 주문에 고정한다(ADR-0025) — 이후 정책이 바뀌어도 이 주문은 이 버전으로 평가한다.
          p_refund_policy_version: CURRENT_REFUND_POLICY_ID,
        });

        if (error) {
          throw new UserFacingError(error.message);
        }
        return { result: null, targetId: orderId as string };
      },
    );

    redirect("/student");
  });
}
