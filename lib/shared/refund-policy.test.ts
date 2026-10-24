import { describe, expect, it } from "vitest";
import {
  CURRENT_REFUND_POLICY_ID,
  LEGACY_REFUND_POLICY_ID,
  REFUND_POLICIES,
  calculateSessionCompensation,
  evaluateRefund,
  fractionText,
  getRefundPolicy,
  type Fraction,
  type RefundSession,
} from "./refund-policy";
import { todayKst } from "./session-progress";

// ---- 도우미: 오늘(2033-06-15)을 기준으로 한 날짜의 회차를 만든다 -------------------------------------
const TODAY = "2033-06-15";
const dayOffset = (days: number) => new Date(new Date(`${TODAY}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
const session = (offsetDays: number, start = "10:00", end = "12:00"): RefundSession => ({ session_date: dayOffset(offsetDays), start_time: start, end_time: end });
const input = (sessions: RefundSession[], extra: Partial<Parameters<typeof evaluateRefund>[0]> = {}) => ({
  paid: 10_000,
  refundable: 10_000,
  listPrice: 10_000,
  sessions,
  today: TODAY,
  policyId: "2026-10-v1",
  ...extra,
});
const amountOf = (sessions: RefundSession[], extra = {}) => evaluateRefund(input(sessions, extra)).amount;

// ---- 시험 ① 불변식 — 등록된 모든 버전이 만족해야 한다 -------------------------------------------------
describe("환불 정책 표 불변식(모든 등록 버전)", () => {
  const validFraction = (f: Fraction) => Number.isInteger(f.n) && Number.isInteger(f.d) && f.d > 0 && f.n >= 0 && f.n <= f.d;

  it("현재 버전과 레거시 버전이 레지스트리에 있다", () => {
    expect(REFUND_POLICIES[CURRENT_REFUND_POLICY_ID]).toBeDefined();
    expect(REFUND_POLICIES[LEGACY_REFUND_POLICY_ID]).toBeDefined();
  });

  for (const [key, policy] of Object.entries(REFUND_POLICIES)) {
    it(`${key}: id가 키와 같고, 개강 전 단계는 일수 내림차순·중복 없음·최소 1일, 모든 비율은 0~1 분수`, () => {
      expect(policy.id).toBe(key);
      expect(policy.notice.length).toBeGreaterThan(0);
      const days = policy.beforeStart.map((r) => r.minDaysBefore);
      expect(days.length).toBeGreaterThan(0);
      expect(days.every((d) => Number.isInteger(d) && d >= 1)).toBe(true);
      expect(new Set(days).size).toBe(days.length);
      expect([...days].sort((a, b) => b - a)).toEqual(days);
      for (const r of policy.beforeStart) expect(validFraction(r.ratio)).toBe(true);
    });

    it(`${key}: 개강 후 구간은 경과비 오름차순(0 초과 1 이하)이고 비율은 0~1 분수·구간이 뒤로 갈수록 비율이 줄지 않는다(늘지 않는다)`, () => {
      const bounds = policy.afterStart.map((r) => r.elapsedBelow.n / r.elapsedBelow.d);
      for (const r of policy.afterStart) {
        expect(validFraction(r.elapsedBelow)).toBe(true);
        expect(validFraction(r.ratio)).toBe(true);
      }
      expect(bounds.every((b) => b > 0 && b <= 1)).toBe(true);
      expect([...bounds].sort((a, b) => a - b)).toEqual(bounds);
      expect(new Set(bounds).size).toBe(bounds.length);
      const ratios = policy.afterStart.map((r) => r.ratio.n / r.ratio.d);
      expect([...ratios].sort((a, b) => b - a)).toEqual(ratios);
    });

    it(`${key}: 위약금 비율은 0~1 분수, 최소 회차 수는 1 이상 정수`, () => {
      expect(validFraction(policy.penalty.ratio)).toBe(true);
      expect(Number.isInteger(policy.penalty.minSessions) && policy.penalty.minSessions >= 1).toBe(true);
    });
  }

  it("모르는 버전 id는 오류", () => {
    expect(() => getRefundPolicy("nope")).toThrow("알 수 없는 환불 정책 버전");
    expect(() => evaluateRefund(input([session(10)], { policyId: "nope" }))).toThrow("알 수 없는 환불 정책 버전");
  });
});

// ---- 시험 ② 경계값 — 각 경계의 직전·정확·직후 --------------------------------------------------------------
describe("2026-10-v1 경계값", () => {
  it("개강 전 남은 일수 7·6·3·2·1일(하루짜리, 위약금 없음)", () => {
    const one = (d: number) => amountOf([session(d)]);
    expect(one(30)).toBe(10_000);
    expect(one(8)).toBe(10_000);
    expect(one(7)).toBe(10_000); // 정확히 7일: 100%
    expect(one(6)).toBe(7_000); // 직후
    expect(one(3)).toBe(7_000); // 정확히 3일: 70%
    expect(one(2)).toBe(3_000);
    expect(one(1)).toBe(3_000); // 정확히 1일: 30%
  });

  it("개강 당일(0일)은 개강 후 구간 — 하루짜리는 경과비 1이라 불가", () => {
    const p = evaluateRefund(input([session(0)]));
    expect(p.eligible).toBe(false);
    expect(p.stage).toBe("NOT_ALLOWED");
    expect(p.amount).toBe(0);
  });

  it("경과비 1/3 직전·정확·직후(분 단위): 59/180 → 2/3, 60/180 → 1/2, 61/180 → 1/2", () => {
    const ratio = (pastMin: number) => {
      // 지난 회차(오늘) pastMin분 + 미래 회차 (180 − pastMin)분
      const past = session(0, "10:00", `${String(10 + Math.floor(pastMin / 60)).padStart(2, "0")}:${String(pastMin % 60).padStart(2, "0")}`);
      const futureMin = 180 - pastMin;
      const future = session(7, "10:00", `${String(10 + Math.floor(futureMin / 60)).padStart(2, "0")}:${String(futureMin % 60).padStart(2, "0")}`);
      return evaluateRefund(input([past, future])).ratio;
    };
    expect(ratio(59)).toEqual({ n: 2, d: 3 });
    expect(ratio(60)).toEqual({ n: 1, d: 2 });
    expect(ratio(61)).toEqual({ n: 1, d: 2 });
  });

  it("경과비 1/2 직전·정확·직후: 89/180 → 1/2, 90/180 → 불가, 91/180 → 불가", () => {
    const stage = (pastMin: number) => {
      const futureMin = 180 - pastMin;
      const fmt = (m: number) => `${String(10 + Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      return evaluateRefund(input([session(0, "10:00", fmt(pastMin)), session(7, "10:00", fmt(futureMin))])).stage;
    };
    expect(stage(89)).toBe("AFTER_START");
    expect(stage(90)).toBe("NOT_ALLOWED");
    expect(stage(91)).toBe("NOT_ALLOWED");
  });

  it("경과비는 회차 개수가 아니라 시간(분)으로 센다: 60분 1회 + 180분 1회에서 60분이 지났으면 1/4", () => {
    const p = evaluateRefund(input([session(0, "10:00", "11:00"), session(7, "10:00", "13:00")]));
    expect(p.elapsed).toEqual({ pastMinutes: 60, totalMinutes: 240 });
    expect(p.ratio).toEqual({ n: 2, d: 3 });
  });

  it("마지막 회차 이후는 경과비 1 → 불가", () => {
    expect(evaluateRefund(input([session(-14), session(-7), session(-1)])).stage).toBe("NOT_ALLOWED");
  });

  it("한국 날짜 경계: 같은 순간이라도 KST 자정을 넘으면 남은 일수가 하루 줄어든다", () => {
    const first = "2033-06-22";
    const before = todayKst(new Date("2033-06-15T14:59:59Z")); // 한국 6/15 23:59:59
    const after = todayKst(new Date("2033-06-15T15:00:00Z")); // 한국 6/16 00:00:00
    const sessions = [{ session_date: first, start_time: "10:00", end_time: "12:00" }];
    expect(evaluateRefund({ ...input(sessions), today: before }).daysBefore).toBe(7);
    expect(evaluateRefund({ ...input(sessions), today: after }).daysBefore).toBe(6);
    expect(evaluateRefund({ ...input(sessions), today: before }).amount).toBe(10_000);
    expect(evaluateRefund({ ...input(sessions), today: after }).amount).toBe(7_000);
  });

  it("월말·연말을 넘기는 일수 계산", () => {
    const p = evaluateRefund({ ...input([{ session_date: "2034-01-02", start_time: "10:00", end_time: "12:00" }]), today: "2033-12-30" });
    expect(p.daysBefore).toBe(3);
    expect(p.amount).toBe(7_000);
  });
});

// ---- 시험 ③ 골든 — 지불 10,000원 결과 표(옛 버전 값이 바뀌면 실패) ------------------------------------------
describe("2026-10-v1 골든(지불 10,000원)", () => {
  const four = [session(0), session(7), session(14), session(21)]; // 4회차(각 120분), 개강 당일
  const five = [session(-7), session(0), session(7), session(14), session(21)]; // 5회차, 2회 지남(2/5 = 0.4)
  const discount = { listPrice: 12_000 };

  const golden: [string, RefundSessions, Partial<Parameters<typeof evaluateRefund>[0]>, number][] = [
    ["개강 7일 전", [session(7)], {}, 10_000],
    ["개강 3일 전", [session(3)], {}, 7_000],
    ["개강 1일 전", [session(1)], {}, 3_000],
    ["4회차 개강 당일(1/4 → 2/3)", four, {}, 6_666],
    ["같은 건이 할인받은 다회차(2/3 − 1/10)", four, discount, 5_666],
    ["1/2 구간(2/5 경과)", five, {}, 5_000],
    ["1/2 구간 + 할인받은 다회차(1/2 − 1/10)", five, discount, 4_000],
    ["개강 당일 하루짜리", [session(0)], {}, 0],
    ["개강 전 + 할인받은 다회차(위약금 없음)", [session(7), session(14)], discount, 10_000],
    ["할인받은 하루짜리 개강 전(위약금 없음)", [session(3)], discount, 7_000],
    ["할인 없는 다회차 개강 후(위약금 없음)", four, { listPrice: 10_000 }, 6_666],
  ];
  type RefundSessions = RefundSession[];

  for (const [name, sessions, extra, expected] of golden) {
    it(`${name} → ${expected.toLocaleString()}원`, () => {
      expect(amountOf(sessions, extra)).toBe(expected);
    });
  }

  it("소수점은 마지막에 한 번만 버린다: 3,333원 × 2/3 = 2,222원, 3,333원 × (2/3 − 1/10) = 1,888원", () => {
    expect(amountOf(four, { paid: 3_333, refundable: 3_333, listPrice: 3_333 })).toBe(2_222);
    expect(amountOf(four, { paid: 3_333, refundable: 3_333, listPrice: 4_000 })).toBe(1_888);
  });
});

describe("보조 규칙", () => {
  it("제안 금액은 환불 가능액을 넘지 않는다", () => {
    const p = evaluateRefund(input([session(7)], { refundable: 4_000 }));
    expect(p.amount).toBe(4_000);
    expect(p.detail).toContain("환불 가능액");
  });

  it("환불 가능액이 0이면 제안도 0", () => {
    expect(amountOf([session(7)], { refundable: 0 })).toBe(0);
  });

  it("비활성(취소) 회차는 회차 수·시간·첫 날짜에서 제외", () => {
    const sessions = [session(1), { ...session(-3), deactivated_at: "2033-01-01T00:00:00Z" }];
    const p = evaluateRefund(input(sessions));
    expect(p.stage).toBe("BEFORE_START");
    expect(p.daysBefore).toBe(1);
  });

  it("활성 회차가 없으면 NO_SESSIONS(제안 없음)", () => {
    const p = evaluateRefund(input([]));
    expect(p).toMatchObject({ eligible: false, stage: "NO_SESSIONS", amount: 0 });
    expect(evaluateRefund(input([{ ...session(3), deactivated_at: "x" }])).stage).toBe("NO_SESSIONS");
  });

  it("정책 버전이 null(옛 주문)이면 레거시 버전으로 계산하고 그 사실을 밝힌다", () => {
    const p = evaluateRefund(input([session(3)], { policyId: null }));
    expect(p.policyId).toBe(LEGACY_REFUND_POLICY_ID);
    expect(p.policyNote).toContain("기록되지 않은");
    expect(p.amount).toBe(7_000);
    expect(evaluateRefund(input([session(3)])).policyNote).toBeNull();
  });

  it("표시 문구: 제안/불가 한 줄과 근거, 고정 안내", () => {
    const ok = evaluateRefund(input([session(3)]));
    expect(ok.headline).toBe("약관 기준 제안: 7,000원 (개강 3일 전 · 70%)");
    expect(ok.detail).toContain("지불 10,000원");
    expect(ok.detail).toContain("정책 2026-10-v1");
    expect(ok.notice).toContain("약관이 정본");
    const no = evaluateRefund(input([session(0)]));
    expect(no.headline).toBe("약관 기준으로는 환불 불가");
  });

  it("분수 표기", () => {
    expect(fractionText({ n: 7, d: 10 })).toBe("70%");
    expect(fractionText({ n: 1, d: 1 })).toBe("100%");
    expect(fractionText({ n: 2, d: 3 })).toBe("2/3");
    expect(fractionText({ n: 1, d: 2 })).toBe("50%");
  });

  describe("calculateSessionCompensation (회차 보상 환불 산식)", () => {
    it("동일 시간 3회차 중 1회차 취소 시 1/3 금액 계산 (1원 단위 버림)", () => {
      const s1 = session(1, "10:00", "12:00"); // 120분
      const s2 = session(3, "10:00", "12:00"); // 120분
      const s3 = session(5, "10:00", "12:00"); // 120분
      const comp = calculateSessionCompensation({
        paid: 10_000,
        refundable: 10_000,
        allSessions: [s1, s2, s3],
        cancelledSessionDate: s1.session_date,
      });
      // 120 / 360 * 10,000 = 3333.333... -> 3,333원
      expect(comp.amount).toBe(3_333);
      expect(comp.cancelledMinutes).toBe(120);
      expect(comp.totalMinutes).toBe(360);
    });

    it("환불 가능 잔액(refundable)을 초과하지 않는다", () => {
      const s1 = session(1, "10:00", "12:00");
      const s2 = session(3, "10:00", "12:00");
      const comp = calculateSessionCompensation({
        paid: 10_000,
        refundable: 2_000, // 잔액이 2,000원뿐임
        allSessions: [s1, s2],
        cancelledSessionDate: s1.session_date,
      });
      // 본래 5,000원이나 refundable 2,000원으로 제한
      expect(comp.amount).toBe(2_000);
    });
  });
});

