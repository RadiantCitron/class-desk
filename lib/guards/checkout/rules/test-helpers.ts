import type { EligibilityContext } from "../types";

// 모든 규칙을 통과하는 "정상 상태"를 기본값으로 두고, 테스트마다 필요한 부분만 덮어쓴다.
// 규칙 테스트가 매번 EligibilityContext 전체를 새로 나열하지 않아도 되게 하는 게 목적이다 —
// 그래야 각 테스트가 "이 규칙이 실제로 보는 조건"만 남아서 테스트 자체가 그 규칙의 명세로 읽힌다.
export function makeContext(overrides: {
  actorProfileId?: string;
  order?: Partial<EligibilityContext["order"]>;
  offering?: Partial<EligibilityContext["offering"]>;
  user?: Partial<EligibilityContext["user"]>;
  termsUpToDate?: boolean;
  discountRuleValid?: boolean;
  requiresDiscord?: boolean;
} = {}): EligibilityContext {
  return {
    actorProfileId: overrides.actorProfileId ?? "user-1",
    order: {
      id: "order-1",
      userId: "user-1",
      offeringId: "offering-1",
      status: "APPROVED",
      paymentStatus: "UNPAID",
      listPrice: 100000,
      finalAmount: 100000,
      discountRuleId: null,
      ...overrides.order,
    },
    offering: {
      status: "OPEN",
      opensAt: null,
      endsAt: null,
      ...overrides.offering,
    },
    user: {
      withdrawnAt: null,
      name: "홍길동",
      phone: "010-0000-0000",
      discordLinked: true,
      ...overrides.user,
    },
    termsUpToDate: overrides.termsUpToDate ?? true,
    discountRuleValid: overrides.discountRuleValid ?? true,
    requiresDiscord: overrides.requiresDiscord ?? false,
  };
}
