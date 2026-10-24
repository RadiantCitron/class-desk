import { redirect } from "next/navigation";
import { getCurrentAuthUser, loadProfileByAuthUserId } from "@/lib/supabase/identity";

// 랜딩 페이지: 로그인 여부/역할에 따라 바로 목적지로 보낸다.
// 미인증 상태에서의 폼 제출 문제를 예방하기 위해 항상 인증부터 유도한다.
// 세션은 있지만 아직 가입(약관 동의)이 완료되지 않은 경우 profile이 null이다.
// 이 경우 /student로 전달하면 proxy 미들웨어가 프로필 부재를 감지하여 /signup/complete로 안내한다.
export default async function Home() {
  const { supabase, user } = await getCurrentAuthUser();

  if (!user) {
    redirect("/login");
  }

  const profile = await loadProfileByAuthUserId(supabase, user.id);

  // STUDENT만 /student로, 나머지(ADMIN·MANAGER, 2026-09-18)는 /admin으로.
  redirect(profile && profile.role !== "STUDENT" ? "/admin" : "/student");
}
