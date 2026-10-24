import { describe, it, expect } from "vitest";
import { notAlreadyPaid } from "./not-already-paid";
import { makeContext } from "./test-helpers";

// 이 규칙 하나만으로는 이중결제를 막지 못한다 — payment_status가 UNPAID인 동안 결제 개시를
// 두 번 해도 둘 다 통과한다. 실제 이중결제 방지는 record_payment_event()의 DB 레벨 가드다
// (supabase/tests/integrity_check.sql TEST12). 이 규칙은 "이미 완료된 결제 건"만 걸러낸다.
describe("NOT_ALREADY_PAID", () => {
  it("payment_status=UNPAID면 통과한다", () => {
    expect(notAlreadyPaid.evaluate(makeContext({ order: { paymentStatus: "UNPAID" } }))).toBe(
      true,
    );
  });

  it.each(["PAID", "REFUNDED"])("payment_status=%s면 거부한다", (status) => {
    expect(notAlreadyPaid.evaluate(makeContext({ order: { paymentStatus: status } }))).toBe(
      false,
    );
  });
});
