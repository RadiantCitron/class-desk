import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// E2E 테스트(Playwright) 전용 로그인. 디스코드 OAuth는 자동화하지 않기로 확정했으므로
// (가입 자체는 사람이 직접 수동으로 해야 한다), 로그인 이후
// 화면들을 테스트하려면 세션을 얻는 경로가 필요하다. `lib/supabase/server.ts`의 동일한
// createClient()를 그대로 써서 프로덕션과 똑같은 방식으로 쿠키가 생성되게 한다 — 쿠키 형식을
// 직접 흉내내면(reverse-engineering) 버전이 바뀔 때마다 깨지기 쉽다.
//
// 실제 로그인은 매직링크지만 e2e가 UI 없이 세션만 빠르게 얻도록 남긴 테스트 전용 경로다. 이중으로 잠근다:
// ① NODE_ENV==='production'이면 무조건 404
// ② ALLOW_TEST_LOGIN=true로 명시적으로 켜야만 동작(기본값 꺼짐).
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production" || process.env.ALLOW_TEST_LOGIN !== "true") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { email, password } = (await request.json()) as { email?: string; password?: string };
  if (!email || !password) {
    return NextResponse.json({ error: "email/password required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
