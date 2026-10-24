import { describe, it, expect } from "vitest";
import { UserFacingError, isUserFacingError, runAction } from "./errors";

// runAction의 계약은 "UserFacingError만 잡는다" 하나다. 이 경계가 무너지면 두 가지가
// 동시에 깨진다: ①예상 못 한 에러를 삼켜 error.tsx가 못 받고 ②redirect()가 던지는 Next.js
// 내부 예외까지 잡혀 성공 후 리다이렉트가 죽는다(신청·결제·탈퇴 세 액션이 실제로 그렇다).
describe("runAction — 예상된 실패만 반환값으로 바꾼다", () => {
  it("성공하면 ok:true와 반환값을 그대로 담는다", async () => {
    await expect(runAction(async () => 42)).resolves.toEqual({ ok: true, data: 42 });
  });

  it("UserFacingError는 ok:false + 메시지로 바뀐다", async () => {
    const result = await runAction(async () => {
      throw new UserFacingError("이미 신청한 강의입니다.");
    });
    expect(result).toEqual({ ok: false, message: "이미 신청한 강의입니다." });
  });

  it("일반 Error는 잡지 않고 그대로 던진다(error.tsx가 받아야 한다)", async () => {
    await expect(
      runAction(async () => {
        throw new Error("상태 갱신 실패: duplicate key");
      }),
    ).rejects.toThrow("상태 갱신 실패: duplicate key");
  });

  it("redirect()가 던지는 형태의 예외는 통과시킨다", async () => {
    // Next.js의 redirect()는 digest가 붙은 특수 예외를 던져 동작한다. 넓게 잡으면
    // 성공 후 리다이렉트가 통째로 죽으므로, 반드시 통과해야 한다.
    const redirectLike = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/student;307;",
    });
    await expect(
      runAction(async () => {
        throw redirectLike;
      }),
    ).rejects.toBe(redirectLike);
  });
});

describe("isUserFacingError — HMR로 클래스 정체성이 갈려도 판정이 유지된다", () => {
  it("instanceof로 잡힌다", () => {
    expect(isUserFacingError(new UserFacingError("x"))).toBe(true);
  });

  it("name만 같아도 잡는다(dev 모듈 재적재 대비)", () => {
    const duplicated = new Error("x");
    duplicated.name = "UserFacingError";
    expect(isUserFacingError(duplicated)).toBe(true);
  });

  it("일반 Error는 아니다", () => {
    expect(isUserFacingError(new Error("x"))).toBe(false);
  });

  it("Error가 아닌 값도 아니다", () => {
    expect(isUserFacingError("문자열")).toBe(false);
    expect(isUserFacingError(null)).toBe(false);
  });
});
