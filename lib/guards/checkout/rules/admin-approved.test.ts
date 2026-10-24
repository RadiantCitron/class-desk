import { describe, it, expect } from "vitest";
import { adminApproved } from "./admin-approved";
import { makeContext } from "./test-helpers";

// 수강신청 승인(APPROVED)과 결제 가능 조건의 관계 검증:
// 관리자가 APPROVED로 승인하기 전에는 어떤 상태에서도 결제를 시작할 수 없다.
describe("ADMIN_APPROVED", () => {
  it.each(["PENDING", "REJECTED", "CANCELLED"])(
    "status=%s이면 거부한다(APPROVED만 통과)",
    (status) => {
      expect(adminApproved.evaluate(makeContext({ order: { status } }))).toBe(
        false,
      );
    },
  );

  it("status=APPROVED면 통과한다", () => {
    expect(adminApproved.evaluate(makeContext({ order: { status: "APPROVED" } }))).toBe(
      true,
    );
  });
});
