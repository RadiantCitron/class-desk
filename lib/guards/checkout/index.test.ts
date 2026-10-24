import { describe, it, expect } from "vitest";
import { evaluateEligibility, RULES } from "./index";
import { makeContext } from "./rules/test-helpers";

// evaluateEligibility()의 핵심 설계는 "첫 실패에서 멈추지 않고 전 규칙을 평가한다"는 것:
// 사용자에게 미충족 조건 목록을 한 번에 종합 안내하기 위함이다.
// 이 파일은 개별 규칙이 아니라 규칙들의 상호작용 및 수집 구조를 검증한다.
describe("evaluateEligibility()", () => {
  it("모든 규칙을 통과하면 eligible=true, failedRules는 비어있다", () => {
    const result = evaluateEligibility(makeContext());
    expect(result.eligible).toBe(true);
    expect(result.failedRules).toEqual([]);
  });

  it("여러 규칙이 동시에 실패해도 첫 실패에서 멈추지 않고 전부 모아서 반환한다", () => {
    const ctx = makeContext({
      order: { status: "PENDING", paymentStatus: "PAID" },
      user: { name: null },
    });

    const result = evaluateEligibility(ctx);

    expect(result.eligible).toBe(false);
    const codes = result.failedRules.map((r) => r.code);
    expect(codes).toEqual(
      expect.arrayContaining(["ADMIN_APPROVED", "NOT_ALREADY_PAID", "PROFILE_COMPLETE"]),
    );
  });

  it("등록된 규칙은 9개다 — 규칙 파일을 추가/삭제했는데 이 숫자가 그대로면 배열 등록을 빠뜨렸다는 신호다(2026-10-02 NO_PENDING_CHECKOUT 제거로 12→11, 2026-10-07 명령 레일 CR-4에서 결제 봉쇄·결제 제한 규칙을 레일로 옮겨 11→9)", () => {
    expect(RULES).toHaveLength(9);
  });

  it("모든 규칙의 code는 서로 달라야 한다(중복되면 결제 실패 메시지가 뒤섞인다)", () => {
    const codes = RULES.map((rule) => rule.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
