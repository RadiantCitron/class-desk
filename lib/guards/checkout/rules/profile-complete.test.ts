import { describe, it, expect } from "vitest";
import { profileComplete } from "./profile-complete";
import { makeContext } from "./test-helpers";

describe("PROFILE_COMPLETE", () => {
  it("이름과 전화번호가 둘 다 있으면 통과한다", () => {
    expect(
      profileComplete.evaluate(makeContext({ user: { name: "홍길동", phone: "010-1234-5678" } })),
    ).toBe(true);
  });

  it("이름이 없으면 거부한다", () => {
    expect(profileComplete.evaluate(makeContext({ user: { name: null } }))).toBe(false);
  });

  it("전화번호가 없으면 거부한다", () => {
    expect(profileComplete.evaluate(makeContext({ user: { phone: null } }))).toBe(false);
  });
});
