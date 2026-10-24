import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// 인증 복귀 Route Handler(app/auth/confirm·app/auth/callback)용 Supabase 클라이언트 — 두 라우트에 똑같이 복제돼 있던 것을
// 어댑터(lib/supabase/)로 모았다(R5 "외주 SDK는 어댑터에서만").
//
// cookies()로만 심고 NextResponse.redirect()를 따로 만들면, Next 16에서 Set-Cookie가 리다이렉트 응답에 안 붙는 경우가
// 있다(옛 콜백에서 겪은 문제) — 그래서 세션 쿠키를 응답 객체에 모았다가 redirectWithSession이 리다이렉트 응답으로 옮긴다.
export function createRouteHandlerClient(request: NextRequest) {
  const { origin } = new URL(request.url);
  let cookieResponse = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          cookieResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // 옵션(만료·sameSite 등)까지 그대로 옮긴다 — 이름·값만 복사하면 세션 쿠키가 브라우저 세션
  // 쿠키로 격하돼 로그인이 예상보다 일찍 풀렸다.
  const redirectWithSession = (path: string) => {
    const redirectResponse = NextResponse.redirect(`${origin}${path}`);
    cookieResponse.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie);
    });
    return redirectResponse;
  };

  return { supabase, redirectWithSession };
}
