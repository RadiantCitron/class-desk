"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { runCommand } from "@/lib/commands/run-command";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";

// 이메일 매직링크 로그인(2026-09-25 재설계). 비밀번호 없음. shouldCreateUser: false로
// 불러 이 화면에서 새 계정이 생기지 않게 한다(가입은 /signup 전용). 명령 이름은 LOGIN(통제실 통로 — 스위치로 막히지 않는다)이고,
// 링크 요청과 확정(app/auth/confirm/route.ts)이 같은 명령이다. 신원이 없는 상태라 기록은 남지 않는다.
export async function requestLoginLink(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    if (!email.includes("@")) {
      throw new UserFacingError("이메일 주소를 확인해 주세요.");
    }

    await runCommand({ command: "LOGIN", targetTable: "users" }, async () => {
      const origin = (await headers()).get("origin") ?? "http://127.0.0.1:3000";
      const supabase = await createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/confirm` },
      });
      if (error) {
        // 가입되지 않은 이메일이면 Supabase가 거부한다 — 존재 여부를 굳이 숨기지 않고 바로 안내한다
        // (가입 유도가 목적이라 "가입 후 로그인" 안내가 더 친절하다).
        throw new UserFacingError("가입되지 않은 이메일이거나 문제가 발생했습니다. 먼저 회원가입을 해 주세요.");
      }
      return { result: undefined };
    });
    redirect(`/login?sent=${encodeURIComponent(email)}`);
  });
}
