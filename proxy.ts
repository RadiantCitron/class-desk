import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { loadProfileByAuthUserId } from "@/lib/supabase/identity";
import { SERVICE_TERMS_TYPE } from "@/lib/terms";
import { canAccessAdminRoute } from "@/lib/auth/permissions";

// updateSession()이 갱신·삭제한 쿠키(response)를 리다이렉트 응답에도 옵션째(만료·sameSite 등) 옮긴다.
// 예전엔 이 파일의 모든 redirect가 새 NextResponse.redirect()를 만들어 그 쿠키를 버렸다 — 탈퇴·게이트
// 거부 시의 signOut()이 브라우저 쿠키를 못 지우고, 토큰 회전과 리다이렉트가 겹치면 회전된 토큰이
// 사라져 무작위 로그아웃이 났다.
function redirect(url: URL, response: NextResponse): NextResponse {
  const redirected = NextResponse.redirect(url);
  response.cookies.getAll().forEach((cookie) => redirected.cookies.set(cookie));
  return redirected;
}

// Next.js 16부터 middleware.ts 대신 proxy.ts + `proxy` export를 사용한다.
export async function proxy(request: NextRequest) {
  const { response, supabase, user } = await updateSession(request);
  const { pathname } = request.nextUrl;

  if (!user) {
    return redirect(new URL("/login", request.url), response);
  }

  // role은 DB(public.users)가 authoritative source다. 환경변수는 최초 가입 시딩에만 쓴다.
  // — user.id는 auth.users.id(세션 id)이고 public.users.id와는 더 이상
  // 같지 않으므로(2026-09-12 식별자 분리) auth_user_id를 거쳐 조회한다.
  // proxy는 next/headers의 cookies()를 못 써서 identity.ts의 getCurrentProfile() 대신
  // 이 요청 전용 supabase 클라이언트를 직접 주입하는 loadProfileByAuthUserId()를 쓴다.
  const profile = await loadProfileByAuthUserId(supabase, user.id);

  // 매직링크는 확인됐지만 약관 동의를 마치지 않은 상태다 — 가입 마무리 화면으로 보낸다.
  if (!profile) {
    return redirect(new URL("/signup/complete", request.url), response);
  }

  // 시스템 봉쇄(통제 스위치 SYSTEM)는 프록시에서 차단하지 않고, 로그인 뒤의 모든 명령(runCommand)과 조회(runQuery)가
  // 동일한 게이트 판정으로 차단한다(관리자 면제 없음). 세션 상태와 무관하게 모든 데이터 액세스가 레일을 거치므로 일관성이 보장된다.

  // 탈퇴 = 소프트 탈퇴(DB 행 삭제 없음). withdrawn_at이 있으면 즉시 로그아웃하고
  // 서비스 접근을 전면 차단한다.
  if (profile.withdrawnAt) {
    await supabase.auth.signOut();
    return redirect(new URL("/withdrawn", request.url), response);
  }

  // 이중 동의 원칙: 로그인 시 서비스 이용약관 동의가 없으면 /admin·/student 접근 불가.
  // terms_agreements.terms_version(text)이 terms_id(FK)로 정규화되어,
  // "SERVICE_USE 종류의 어떤 버전이든 동의했는가"를 embedded 필터로 확인한다.
  // user_id는 public.users.id(=profile.id) 값이다 — auth.users.id(user.id)를 쓰지 않는다.
  //
  // limit(1) 없이 maybeSingle()만 쓰면, 약관 버전을 두 번 이상 동의한 사람(개정 약관 재동의)은
  // PostgREST가 복수 행 반환 시 data=null(PGRST116)을 돌려줄 수 있으므로 limit(1)을 강제한다.
  const { data: agreement, error: agreementError } = await supabase
    .from("terms_agreements")
    .select("id, terms!inner(type)")
    .eq("user_id", profile.id)
    .eq("terms.type", SERVICE_TERMS_TYPE)
    .limit(1)
    .maybeSingle();

  if (agreementError) {
    console.error("서비스약관 동의 조회 실패:", agreementError);
    return redirect(new URL("/login?error=auth_failed", request.url), response);
  }

  if (!agreement) {
    return redirect(new URL("/terms", request.url), response);
  }

  // 역할이 셋(ADMIN/MANAGER/STUDENT)이 된 뒤(2026-09-18)에는 "둘 중 하나가 아니면 반대쪽"
  // 식으로 나누면 MANAGER가 /admin↔/student 사이에서 무한 리다이렉트에 빠진다. 그래서
  // "/student는 STUDENT만" / "/admin은 STUDENT가 아니면(=ADMIN·MANAGER)"으로 나누고,
  // /admin 안에서는 추가로 canAccessAdminRoute()가 경로별 권한을 검사한다(매니저가 권한 없는
  // /admin/* 하위 경로로 직접 이동해도 /admin 대시보드로 돌려보낸다).
  if (pathname.startsWith("/student") && profile.role !== "STUDENT") {
    return redirect(new URL("/admin", request.url), response);
  }

  if (pathname.startsWith("/admin")) {
    if (profile.role === "STUDENT") {
      return redirect(new URL("/student", request.url), response);
    }
    if (!canAccessAdminRoute(profile.role, profile.permissions, pathname)) {
      return redirect(new URL("/admin", request.url), response);
    }
  }

  return response;
}

export const config = {
  matcher: ["/admin/:path*", "/student/:path*", "/api/downloads/:path*"],
};
