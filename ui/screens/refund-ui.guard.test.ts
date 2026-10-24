import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("Code-C 수강생 환불 UI 가드", () => {
  const root = process.cwd();

  it("학생 페이지: 수강생 환불 모달은 결제 파사드를 화면에 직접 노출하지 않고 단일 액션을 사용한다", () => {
    const page = readFileSync(join(root, "ui/screens/student/StudentHomeScreen.tsx"), "utf-8");
    // 카드가 아닌 결제 등 신청 버튼이 없는 건의 안내는 그대로 남는다.
    expect(page).toContain("환불은 관리자에게 문의해 주세요");
    expect(page).not.toMatch(/@\/lib\/payment/);
    expect(page).not.toMatch(/requestOrderRefund|PAYMENT_REFUND_REQUEST/);

    const request = readFileSync(join(root, "ui/screens/student/StudentRefundRequest.tsx"), "utf-8");
    // 신청 안내 문구와 모달이 적절히 존재한다.
    expect(request).toContain("자동으로 환불되지 않고");
    expect(request).toContain("환불을 진행할까요?");
    expect(request).toContain("환불을 신청할까요?");
    expect(request).not.toMatch(/@\/lib\/payment/);
  });

  it("학생 서버 액션은 request_order_refund 및 자동환불 명령을 수행한다", () => {
    const actions = readFileSync(join(root, "app/student/actions.ts"), "utf-8");
    expect(actions).toContain("request_order_refund");
    expect(actions).toContain("PAYMENT_REFUND_AUTO");
  });

  it("관리자 payments 목록에는 환불 개시가 없다", () => {
    const payments = readFileSync(join(root, "ui/screens/admin/payments/PaymentsScreen.tsx"), "utf-8");
    expect(payments).not.toMatch(/requestRefund|requestOrderRefund/);
  });
});
