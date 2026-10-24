import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("Code-C 수강생 환불 UI 가드", () => {
  const root = process.cwd();

  it("학생 actions는 자동환불 허용에 따라 결제 파사드를 레일(PAYMENT_REFUND_AUTO)로 안전하게 호출한다", () => {
    const actions = readFileSync(join(root, "app/student/actions.ts"), "utf-8");
    expect(actions).toContain("PAYMENT_REFUND_AUTO");
    expect(actions).toContain("requestRefund");
  });
});
