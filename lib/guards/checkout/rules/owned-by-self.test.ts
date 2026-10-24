import { describe, it, expect } from "vitest";
import { ownedBySelf } from "./owned-by-self";
import { makeContext } from "./test-helpers";

// 소유권 검증: 타인의 신청 ID로 결제 URL에 직접 접근하는 행위를 차단한다.
// RLS(DB 레벨)가 1차 방어선이고, 애플리케이션 가드가 2차 방어선으로 방어한다.
describe("OWNED_BY_SELF", () => {
  it("세션 사용자와 신청 소유자가 같으면 통과한다", () => {
    const ctx = makeContext({ actorProfileId: "user-1", order: { userId: "user-1" } });
    expect(ownedBySelf.evaluate(ctx)).toBe(true);
  });

  it("세션 사용자와 신청 소유자가 다르면 거부한다", () => {
    const ctx = makeContext({ actorProfileId: "user-1", order: { userId: "user-2" } });
    expect(ownedBySelf.evaluate(ctx)).toBe(false);
  });
});
