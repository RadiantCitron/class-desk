import { describe, it, expect } from "vitest";
import { offeringOpen } from "./offering-open";
import { makeContext } from "./test-helpers";

// 개설강의 모집 기간 및 상태 검증:
// status='OPEN' 상태라 하더라도 모집 종료 시점(ends_at)이 경과했다면 결제를 차단한다.
describe("OFFERING_OPEN", () => {
  it("status=OPEN이고 종료일이 없으면 통과한다", () => {
    expect(offeringOpen.evaluate(makeContext({ offering: { status: "OPEN", endsAt: null } }))).toBe(
      true,
    );
  });

  it("status가 OPEN이 아니면 거부한다", () => {
    expect(offeringOpen.evaluate(makeContext({ offering: { status: "CLOSED", endsAt: null } }))).toBe(
      false,
    );
  });

  it("종료일이 이미 지났으면 status=OPEN이어도 거부한다(결함 A 재발 방지)", () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(offeringOpen.evaluate(makeContext({ offering: { status: "OPEN", endsAt: past } }))).toBe(
      false,
    );
  });

  it("종료일이 아직 안 지났으면 통과한다", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(offeringOpen.evaluate(makeContext({ offering: { status: "OPEN", endsAt: future } }))).toBe(
      true,
    );
  });

  it("개강일(opensAt)이 이미 지났으면 거부하고 개강 안내 문구를 반환한다", () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const ctx = makeContext({ offering: { status: "OPEN", opensAt: past } });
    expect(offeringOpen.evaluate(ctx)).toBe(false);
    expect(offeringOpen.messageFor?.(ctx)).toBe("개강한 수업은 결제할 수 없습니다. 관리자에게 문의해 주세요.");
  });

  it("개강일(opensAt)이 아직 안 지났으면 통과한다", () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const ctx = makeContext({ offering: { status: "OPEN", opensAt: future } });
    expect(offeringOpen.evaluate(ctx)).toBe(true);
  });
});
