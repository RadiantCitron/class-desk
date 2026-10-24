import { Profile } from "@/lib/supabase/identity";
import { UserFacingError } from "@/lib/errors";

/**
 * 전역 가드: 사용자가 필수 약관에 모두 동의했는지 확인합니다.
 * 미동의 약관이 있다면 UserFacingError를 던져 액션을 차단하고 UI로 안내합니다.
 */
export async function assertTermsAgreed(profile: Profile) {
  if (profile.pendingTerms && profile.pendingTerms.length > 0) {
    throw new UserFacingError("개정된 필수 약관에 동의해야 서비스를 계속 이용할 수 있습니다. 메인 화면으로 이동하여 동의해 주세요.");
  }
}
