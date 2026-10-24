import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { GATE_CODES } from "./gates";

// 구조적 강제 테스트(identity.guard.test.ts 선례) — "웹훅/결제창 런치는 봉쇄 스위치의
// 영향을 받지 않는다"는 설계 결정(웹훅은 절대 막지 않는다)을
// 코드 리뷰가 아니라 테스트로 고정한다. 새 코드가 실수로 이 파일들에 게이트 검사를
// 끼워 넣으면, "이미 결제창을 연 사람의 돈이 빠져나갔는데 기록이 없는" 사고로 이어질 수
// 있어 리뷰 전에 이 테스트가 먼저 걸려야 한다.
const root = process.cwd();

function readSource(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf-8");
}

describe("게이트 구조 가드", () => {
  it("결제 웹훅 핸들러는 봉쇄 스위치를 import하지 않는다(출구는 절대 막지 않는다)", () => {
    const code = readSource("app/api/webhooks/payment/[provider]/route.ts");
    expect(code).not.toMatch(/lib\/system\/gates/);
    expect(code).not.toMatch(/lib\/commands\//); // 레일(runCommand·checkRail·스위치 조회)도 쓰지 않는다 — 사실 처리 5곳은 레일 밖이다
  });

  it("토스 결제 컴포넌트도 봉쇄 스위치를 import하지 않는다 — 이미 결제창을 연 사람은 웹훅과 같은 출구다(막는 곳은 서버 가드 한 곳)", () => {
    const client = readSource("app/student/payment/[orderId]/TossPayment.tsx");
    expect(client).not.toMatch(/lib\/system\/gates/);
  });

  it("GATE_CODES는 AUDIT 하나뿐이다 — PAYMENT·SIGNUP·LOGIN은 통제 스위치(rail_switches)로 옮겨 갔다", () => {
    expect([...GATE_CODES]).toEqual(["AUDIT"]);
  });

  it("GATE_CODES의 각 코드는 마이그레이션 시드(DB)에 있다(옛 PAYMENT·SIGNUP·LOGIN 행은 이력으로 남아 있고 더 쓰지 않는다)", () => {
    const migrations = [
      "supabase/migrations/20260920100000_system_gates.sql",
      "supabase/migrations/20260921120000_audit_gate.sql",
    ];
    const seeded: string[] = [];
    for (const path of migrations) {
      const migration = readSource(path);
      const seedMatch = migration.match(
        /insert into public\.system_gates \(code\) values ([^;]+);/,
      );
      expect(seedMatch).not.toBeNull();
      seeded.push(...Array.from(seedMatch![1].matchAll(/'([A-Z_]+)'/g)).map((m) => m[1]));
    }

    for (const code of GATE_CODES) expect(seeded).toContain(code);
  });
});
