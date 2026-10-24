import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// 토스 결제 컴포넌트(결제 페이지의 TossPayment.tsx)는 토스가 추천하는 신형 "결제창형"(widgets) 순서로 SDK를 부른다.
// 구버전 "결제창(구버전)"(payment().requestPayment)은 키 종류(API 개별 연동 키)가 달라
// 현재 키(주문서형·결제창형 연동 키 gck/gsk)와 짝이 맞지 않는다 — 되돌아가면 여기서 걸린다.
const client = readFileSync(
  join(process.cwd(), "app/student/payment/[orderId]/TossPayment.tsx"),
  "utf-8",
);

describe("토스 결제 컴포넌트 — 결제창형(widgets) 호출 가드", () => {
  it("widgets → setAmount → renderPaymentWindow → paymentRequest → requestPayment 순서로 호출한다", () => {
    // 타입 선언부가 아니라 실제 호출부의 순서를 본다 — 앞 토큰 위치 뒤에서 다음 토큰을 찾는다.
    let from = 0;
    for (const token of [".widgets(", ".setAmount(", ".renderPaymentWindow(", '"paymentRequest"', ".requestPayment("]) {
      const at = client.indexOf(token, from);
      expect(at, token + " 가 앞 단계 뒤에 있어야 한다").toBeGreaterThanOrEqual(0);
      from = at + token.length;
    }
  });

  it("구버전 결제창 호출(payment().requestPayment)을 쓰지 않는다", () => {
    expect(client).not.toMatch(/\.payment\(/);
  });

  it("renderPaymentWindow와 requestPayment에 같은 orderName을 넘긴다(SDK가 다르면 거부한다)", () => {
    expect(client).toMatch(/renderPaymentWindow\(\s*\{\s*orderName\s*\}\s*\)/);
    expect(client).toMatch(/requestPayment\(\s*\{[^}]*\borderName\b/);
  });
});
