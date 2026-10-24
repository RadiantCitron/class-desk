import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeContext } from "./rules/test-helpers";

const loadContextMock = vi.fn();
let attemptResult: { data: unknown; error: { message: string } | null } = {
  data: null,
  error: null,
};
let paymentEventResult: { data: unknown; error: { message: string } | null } = {
  data: null,
  error: null,
};

vi.mock("./context", () => ({
  loadEligibilityContext: (...args: unknown[]) => loadContextMock(...args),
}));

// payment_attempts 및 payment_events 조회 체인(select/eq/order/limit → maybeSingle) 흉내
vi.mock("@/lib/supabase/server", () => {
  return {
    createClient: async () => ({
      from: (table: string) => {
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
        chain.maybeSingle = async () => (table === "payment_events" ? paymentEventResult : attemptResult);
        return chain;
      },
    }),
  };
});

import { assertCheckoutEligibleForReturn } from "./index";

// F-9: 복귀는 "소유·활성·금액"만 다시 본다 — 결제창에 머무는 사이 모집이 마감되거나 약관·프로필이 바뀌어도
// 복귀 처리는 막히면 안 된다(RETURN_SOFTENED_CODES). 결제 봉쇄·학생 결제 제한은 이 가드가 아니라 명령 레일이
// PAYMENT_CONFIRM에서 본다 — 승인 API를 부르기 전이라 막혀도 결제가 확정되지 않는다(toss.ts confirm).
describe("assertCheckoutEligibleForReturn() — 복귀 가드(B9)", () => {
  beforeEach(() => {
    loadContextMock.mockReset();
    attemptResult = {
      data: { provider: "TOSS", id: "attempt-1" },
      error: null,
    };
    paymentEventResult = {
      data: { metadata: { attempt_ref: "attempt-1" } },
      error: null,
    };
  });

  it("모집마감·약관·프로필·디스코드가 막혀도 이미 결제된(PAID) 주문 + 같은 시도면 통과한다", async () => {
    loadContextMock.mockResolvedValue(
      makeContext({
        offering: { status: "CLOSED" },
        termsUpToDate: false,
        user: { name: null, discordLinked: false },
        requiresDiscord: true,
        order: { paymentStatus: "PAID" },
      }),
    );

    await expect(
      assertCheckoutEligibleForReturn("order-1", "user-1", "attempt-1"),
    ).resolves.toMatchObject({ providerName: "TOSS", attemptId: "attempt-1" });
  });

  it("이미 결제된(PAID) 주문 + 다른 시도 복귀면 이중 결제 방지로 거부한다", async () => {
    loadContextMock.mockResolvedValue(
      makeContext({
        order: { paymentStatus: "PAID" },
      }),
    );
    paymentEventResult = {
      data: { metadata: { attempt_ref: "attempt-other" } },
      error: null,
    };

    await expect(
      assertCheckoutEligibleForReturn("order-1", "user-1", "attempt-1"),
    ).rejects.toThrow("이미 결제(또는 처리)된 신청입니다. 이번 결제는 승인하지 않았습니다.");
  });

  it("이미 결제된(PAID) 주문 + 성공 이벤트 metadata에 attempt_ref가 없으면 거부한다", async () => {
    loadContextMock.mockResolvedValue(
      makeContext({
        order: { paymentStatus: "PAID" },
      }),
    );
    paymentEventResult = {
      data: { metadata: {} },
      error: null,
    };

    await expect(
      assertCheckoutEligibleForReturn("order-1", "user-1", "attempt-1"),
    ).rejects.toThrow("이미 결제(또는 처리)된 신청입니다. 이번 결제는 승인하지 않았습니다.");
  });

  it("결제 전(UNPAID) 주문 + 디스코드 수업 + 미연결이면 복귀 시 거부한다", async () => {
    loadContextMock.mockResolvedValue(
      makeContext({
        user: { discordLinked: false },
        requiresDiscord: true,
        order: { paymentStatus: "UNPAID" },
      }),
    );

    await expect(
      assertCheckoutEligibleForReturn("order-1", "user-1", "attempt-1"),
    ).rejects.toThrow(/디스코드에서 진행하는 강의입니다/);
  });

  it("결제 전(UNPAID) 주문 + 디스코드 없는 수업이면 미연결이어도 복귀 통과한다", async () => {
    loadContextMock.mockResolvedValue(
      makeContext({
        user: { discordLinked: false },
        requiresDiscord: false,
        order: { paymentStatus: "UNPAID" },
      }),
    );

    await expect(
      assertCheckoutEligibleForReturn("order-1", "user-1", "attempt-1"),
    ).resolves.toMatchObject({ providerName: "TOSS", attemptId: "attempt-1" });
  });

  it("소유자가 다르거나 금액이 잘못이면 복귀도 거부한다", async () => {
    loadContextMock.mockResolvedValue(makeContext({ actorProfileId: "other" }));
    await expect(
      assertCheckoutEligibleForReturn("order-1", "other", "attempt-1"),
    ).rejects.toThrow(/결제할 수 없습니다/);

    loadContextMock.mockResolvedValue(makeContext({ order: { finalAmount: 0 } }));
    await expect(
      assertCheckoutEligibleForReturn("order-1", "user-1", "attempt-1"),
    ).rejects.toThrow(/결제할 수 없습니다/);
  });

  it("결제 시도 기록이 없으면 제공자를 확인할 수 없다", async () => {
    loadContextMock.mockResolvedValue(makeContext());
    attemptResult = { data: null, error: null };
    await expect(
      assertCheckoutEligibleForReturn("order-1", "user-1", "attempt-1"),
    ).rejects.toThrow("이 결제 시도의 제공자를 확인할 수 없습니다.");
  });
});
