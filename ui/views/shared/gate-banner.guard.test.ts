import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// 화면 규칙: 봉쇄 배너는 통제 스위치(명령 레일)만 보여 준다 — 옛 게이트 목록(GATE_CODES·system_gates)을 읽지 않는다.
// 옛 목록에는 학생이 알 필요 없는 AUDIT(감사 기록 on/off)이 있었다(그래서 예전엔 USER_FACING_GATE_CODES만 순회하게 강제했다).
// 스위치 테이블에는 AUDIT이 없으므로 "스위치만 읽는다"가 같은 보장을 준다.
describe("봉쇄 배너 가드", () => {
  it("gate-banner.ts는 통제 스위치만 읽고 옛 게이트 목록·테이블을 쓰지 않는다", () => {
    const bannerCode = readFileSync(join(process.cwd(), "ui/views/shared/gate-banner.ts"), "utf-8");
    expect(bannerCode).toMatch(/loadRailSwitches/);
    expect(bannerCode).not.toMatch(/\bGATE_CODES\b|USER_FACING_GATE_CODES|system_gates|loadGates/);
  });
});
