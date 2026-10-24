import { createClient } from "@supabase/supabase-js";

// service_role 클라이언트: RLS를 우회한다. 웹훅 핸들러/인증 콜백/관리자 서버 액션에서만 사용하고,
// 절대 브라우저로 내려보내지 않는다(SUPABASE_SERVICE_ROLE_KEY는 NEXT_PUBLIC_ 접두사가 없다).
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
