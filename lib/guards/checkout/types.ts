// 결제 자격검증 컨텍스트. 규칙 1개당 파일 1개(순수함수) 구조로 조건 추가/삭제를 모듈화한다.
// 정적인 플래그 컬럼 대신 매 요청 순수함수로 재평가하여 규칙 변경 시의 상태 불일치(stale flag)를 방지한다.
export type EligibilityContext = {
  // 세션의 auth.users.id가 아니라 public.users.id(=Profile.id)다 — 2026-09-12 식별자 분리
  // 이후 이 필드에 auth id를 넣으면 owned-by-self 규칙이 항상 거부(fail-closed)로 깨진다.
  actorProfileId: string;
  order: {
    id: string;
    userId: string;
    // 5단계(물품 추가, 2026-09-23)부터 개설강의 또는 상품 중 하나만 채워진다
    // (orders_item_exactly_one CHECK와 동일한 전제) — 품목 자체 정보는 ctx.offering에서 읽는다.
    offeringId: string | null;
    status: string;
    paymentStatus: string;
    listPrice: number | null;
    finalAmount: number | null;
    discountRuleId: string | null;
  };
  offering: {
    status: string;
    opensAt: string | null;
    endsAt: string | null;
  };
  user: {
    withdrawnAt: string | null;
    name: string | null;
    phone: string | null;
    discordLinked: boolean;
  };
  termsUpToDate: boolean;
  discountRuleValid: boolean;
  // 이 품목(강의)의 grants에 디스코드 역할이 있는지(discord-linked 규칙).
  requiresDiscord: boolean;
};

export type EligibilityRule = {
  code: string;
  message: string;
  evaluate(ctx: EligibilityContext): boolean;
  messageFor?(ctx: EligibilityContext): string;
};

export type EligibilityFailure = { code: string; message: string };

export type EligibilityResult = {
  eligible: boolean;
  failedRules: EligibilityFailure[];
};
