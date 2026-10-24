import type { SupabaseClient } from "@supabase/supabase-js";

// 이중 동의 원칙: 로그인 시 서비스 이용약관 + 신청 시 결제/개인정보 약관을 각각 별도로 동의받는다.
//
// 약관 내용은 코드 상수가 아니라 `public.terms` 테이블에 버전별로 저장 관리한다.
// 여기서는 약관 종류(type)를 정의한다.
export const SERVICE_TERMS_TYPE = "SERVICE_USE";
export const APPLICATION_PRIVACY_TERMS_TYPE = "PRIVACY_USE";

// 과목별 조건부 약관(국룰 체계 확장, 2026-09-11 확정·구현) — 가입 시 일괄로 받지 않고(과다수집
// 안티패턴), 실제로 그 처리를 하는 개설강의를 신청할 때만 동적으로 추가 동의를 받는다.
// `course_offerings.required_terms_types`에 이 중 필요한 것만 골라 넣는다.
export const THIRD_PARTY_SHARE_TERMS_TYPE = "THIRD_PARTY_SHARE";
export const MARKETING_OPT_IN_TERMS_TYPE = "MARKETING_OPT_IN";
export const AI_CROSS_BORDER_TERMS_TYPE = "AI_CROSS_BORDER_TRANSFER";
export const SOFTWARE_LICENSE_TERMS_TYPE = "SOFTWARE_LICENSE_USE";

// course_offerings.required_terms_types에 넣을 수 있는 값(SERVICE_USE/PRIVACY_USE는 모든
// 개설강의에 공통 베이스라인이라 여기 포함하지 않는다 — DB CHECK와 동일한 목록을 유지할 것).
//
// MARKETING_OPT_IN(광고성 정보 수신 동의)은 2026-09-26부터 이 목록에서 뺐다 — 정보통신망법
// 제50조상 마케팅 동의는 서비스 이용의 조건으로 걸 수 없다(선택 동의만 가능). 가입 화면
// (app/signup/complete/page.tsx)과 프로필 화면(app/student/profile/page.tsx)의 독립적인
// 선택 체크박스로 옮겼다 — users.marketing_email_opt_in이 현재 상태를 캐시한다.
export const CONDITIONAL_TERMS_TYPES = [
  THIRD_PARTY_SHARE_TERMS_TYPE,
  AI_CROSS_BORDER_TERMS_TYPE,
  SOFTWARE_LICENSE_TERMS_TYPE,
] as const;

export const TERMS_TYPE_LABELS: Record<string, string> = {
  [SERVICE_TERMS_TYPE]: "서비스 이용약관",
  [APPLICATION_PRIVACY_TERMS_TYPE]: "개인정보 수집·이용 동의",
  [THIRD_PARTY_SHARE_TERMS_TYPE]: "개인정보 제3자 제공 동의",
  [MARKETING_OPT_IN_TERMS_TYPE]: "마케팅 정보 수신 동의",
  [AI_CROSS_BORDER_TERMS_TYPE]: "AI 서비스 이용을 위한 개인정보 국외이전 동의",
  [SOFTWARE_LICENSE_TERMS_TYPE]: "소프트웨어(소스코드) 이용허락 동의",
};

// 특정 종류(type)의 "현재 유효한" 약관 1건을 가져온다(effective_at 최신순).
// 버전이 나중에 올라가도 terms_agreements의 과거 동의 이력은 terms_id로 그대로 보존된다.
export async function getCurrentTerms(supabase: SupabaseClient, type: string) {
  const { data } = await supabase
    .from("terms")
    .select("id, version, content, effective_at")
    .eq("type", type)
    .order("effective_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data;
}

export type RequiredTermsItem = {
  type: string;
  terms: { id: string; version: string; content: string } | null;
  alreadyAgreed: boolean;
};

// 신청 시점에 실제로 받아야 하는 약관 목록을 계산한다: PRIVACY_USE(모든 품목 공통)
// + THIRD_PARTY_SHARE(실 PG 연동 후 결제대행 제공, 2026-09-29 활성화) + 그 품목의 `required_terms_types`(있다면). 이미 최신 버전에 동의한
// 항목은 alreadyAgreed=true로 표시해, 화면에서 재동의를 요구하지 않게 한다.
//
// R1 모듈 격리: 회원 모듈이 course_offerings/products(주문 모듈)를 직접 읽지 않는다.
// "이 품목에 추가로 필요한 약관 종류"는 호출자(진입점)가 품목 조회 시 함께 읽어 배열로 전달한다.
export async function getRequiredTermsForOffering(
  supabase: SupabaseClient,
  userId: string,
  requiredTermsTypes: string[],
): Promise<RequiredTermsItem[]> {
  // THIRD_PARTY_SHARE는 조건부 목록에도 있을 수 있다 — 중복 제거.
  const types = [
    APPLICATION_PRIVACY_TERMS_TYPE,
    THIRD_PARTY_SHARE_TERMS_TYPE,
    ...requiredTermsTypes.filter((t) => t !== THIRD_PARTY_SHARE_TERMS_TYPE),
  ];

  const items: RequiredTermsItem[] = [];
  for (const type of types) {
    const terms = await getCurrentTerms(supabase, type);
    let alreadyAgreed = false;

    if (terms) {
      const { data: agreement } = await supabase
        .from("terms_agreements")
        .select("id")
        .eq("user_id", userId)
        .eq("terms_id", terms.id)
        .maybeSingle();
      alreadyAgreed = !!agreement;
    }

    items.push({ type, terms, alreadyAgreed });
  }

  return items;
}
