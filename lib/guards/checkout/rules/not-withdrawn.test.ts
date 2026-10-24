import { describe, it, expect } from "vitest";
import { notWithdrawn } from "./not-withdrawn";
import { makeContext } from "./test-helpers";

// 탈퇴는 소프트 탈퇴라 계정 행이 남아있다 — DB에 흔적이 남아있다는 이유로
// 결제까지 통과시키면 안 된다는 게 이 규칙의 존재 이유다.
describe("NOT_WITHDRAWN", () => {
  it("탈퇴하지 않은 계정(withdrawn_at=null)은 통과한다", () => {
    expect(notWithdrawn.evaluate(makeContext({ user: { withdrawnAt: null } }))).toBe(true);
  });

  it("탈퇴한 계정(withdrawn_at 존재)은 거부한다", () => {
    expect(
      notWithdrawn.evaluate(makeContext({ user: { withdrawnAt: "2026-01-01T00:00:00Z" } })),
    ).toBe(false);
  });
});
