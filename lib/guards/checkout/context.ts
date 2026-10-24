import type { SupabaseClient } from "@supabase/supabase-js";
import { SERVICE_TERMS_TYPE, getCurrentTerms, getRequiredTermsForOffering } from "@/lib/terms";
import { one } from "@/lib/supabase/relations";
import { offeringRequiresDiscord } from "@/lib/guards/discord-linked";
import type { EligibilityContext } from "./types";

// 단일 쿼리로 필요한 값을 전부 모아온다(N+1 방지). 결제 페이지 렌더 시 1회, 결제 시작 서버액션에서
// 재검증 시 1회 — 같은 함수를 다른 시점에 두 번 호출하는 것이 이 시스템의 2중 방어다.
export async function loadEligibilityContext(
  supabase: SupabaseClient,
  orderId: string,
  actorProfileId: string,
): Promise<EligibilityContext | null> {
  const { data: order } = await supabase
    .from("orders")
    .select(
      "id, user_id, course_offering_id, product_id, status, payment_status, list_price, final_amount, discount_rule_id, course_offerings(status, opens_at, ends_at, grants, required_terms_types), products(status, required_terms_types)",
    )
    .eq("id", orderId)
    .maybeSingle();

  if (!order) return null;

  const { data: profile } = await supabase
    .from("users")
    .select("withdrawn_at, name, phone")
    .eq("id", order.user_id)
    .maybeSingle();

  // users.discord_id는 2026-09-27에 없어졌다 — 디스코드 연결 여부는 discord_accounts(이용권
  // 모듈 소유)에서 읽는다(lib/entitlements/handlers.ts의 loadDiscordId()와 같은 패턴).
  const { data: discordAccount } = await supabase
    .from("discord_accounts")
    .select("discord_id")
    .eq("user_id", order.user_id)
    .maybeSingle();

  // 결제 자격검증의 약관 확인은 신청 화면과 같은 기준을 쓴다(lib/terms.ts의
  // getRequiredTermsForOffering) — SERVICE_USE(가입) + PRIVACY_USE·THIRD_PARTY_SHARE(신청·결제
  // 공통, 실 PG 연동 후 제3자 제공 포함) + 이 품목의 required_terms_types(있다면).
  const serviceTerms = await getCurrentTerms(supabase, SERVICE_TERMS_TYPE);
  const requiredTermsTypes = order.course_offering_id
    ? ((one(order.course_offerings)?.required_terms_types as string[] | null) ?? [])
    : ((one(order.products)?.required_terms_types as string[] | null) ?? []);
  const offeringTerms = await getRequiredTermsForOffering(supabase, order.user_id, requiredTermsTypes);

  let termsUpToDate = true;
  if (!serviceTerms) {
    termsUpToDate = false;
  } else {
    const { data: serviceAgreement } = await supabase
      .from("terms_agreements")
      .select("id")
      .eq("user_id", order.user_id)
      .eq("terms_id", serviceTerms.id)
      .maybeSingle();
    if (!serviceAgreement) termsUpToDate = false;
  }
  // getRequiredTermsForOffering()은 "약관 원문 자체가 없는" 항목을 terms:null로 표시한다 —
  // 관리자가 course_offerings.required_terms_types에 등록만 하고 원문을 안 만든 상태이므로,
  // 이 경우도 자격 미충족으로 취급한다(조용히 통과시키지 않는다).
  if (offeringTerms.some((item) => !item.terms || !item.alreadyAgreed)) {
    termsUpToDate = false;
  }

  let discountRuleValid = true;
  if (order.discount_rule_id) {
    const { data: rule } = await supabase
      .from("discount_rules")
      .select("valid_from, valid_until")
      .eq("id", order.discount_rule_id)
      .maybeSingle();
    const today = new Date().toISOString().slice(0, 10);
    discountRuleValid =
      !!rule &&
      (!rule.valid_from || rule.valid_from <= today) &&
      (!rule.valid_until || rule.valid_until >= today);
  }

  return {
    actorProfileId,
    order: {
      id: order.id,
      userId: order.user_id,
      offeringId: order.course_offering_id,
      status: order.status,
      paymentStatus: order.payment_status,
      listPrice: order.list_price,
      finalAmount: order.final_amount,
      discountRuleId: order.discount_rule_id,
    },
    // 품목이 개설강의든 상품이든 ctx.offering 한 필드로 받는다 — orders_item_exactly_one
    // CHECK(5단계, 2026-09-23)로 둘 중 하나만 채워지므로, 채워진 쪽을 읽는다. 상품은 마감일
    // 개념이 없어 endsAt은 항상 null이다(offering-open 규칙 참고).
    offering: {
      status: order.course_offering_id
        ? one(order.course_offerings)?.status ?? "CLOSED"
        : one(order.products)?.status ?? "CLOSED",
      opensAt: order.course_offering_id ? one(order.course_offerings)?.opens_at ?? null : null,
      endsAt: order.course_offering_id ? one(order.course_offerings)?.ends_at ?? null : null,
    },
    user: {
      withdrawnAt: profile?.withdrawn_at ?? null,
      name: profile?.name ?? null,
      phone: profile?.phone ?? null,
      discordLinked: !!discordAccount?.discord_id,
    },
    termsUpToDate,
    discountRuleValid,
    requiresDiscord: order.course_offering_id
      ? offeringRequiresDiscord(one(order.course_offerings)?.grants)
      : false,
  };
}
