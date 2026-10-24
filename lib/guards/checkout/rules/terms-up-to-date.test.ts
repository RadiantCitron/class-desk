import { describe, it, expect } from "vitest";
import { termsUpToDate } from "./terms-up-to-date";
import { makeContext } from "./test-helpers";

// 실제 판정 로직(공통 약관 + 개설강의별 조건부 약관 확인)은 컨텍스트를 만드는 쪽
// (lib/guards/checkout/context.ts의 loadEligibilityContext())에 있고, 이 규칙은 그
// 결과값(ctx.termsUpToDate)을 그대로 읽기만 한다 — 그래서 여기서는 통과/전달만 검증한다.
describe("TERMS_UP_TO_DATE", () => {
  it("컨텍스트의 termsUpToDate가 true면 통과한다", () => {
    expect(termsUpToDate.evaluate(makeContext({ termsUpToDate: true }))).toBe(true);
  });

  it("컨텍스트의 termsUpToDate가 false면 거부한다", () => {
    expect(termsUpToDate.evaluate(makeContext({ termsUpToDate: false }))).toBe(false);
  });
});
