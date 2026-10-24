"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { runCommand } from "@/lib/commands/run-command";

// 로그아웃도 명령 레일의 명령이다(LOGOUT, 통제실 통로 — 스위치로 막히지 않는다).
export async function signOut() {
  await runCommand({ command: "LOGOUT", targetTable: "users" }, async () => {
    const supabase = await createClient();
    await supabase.auth.signOut();
    return { result: undefined };
  });
  redirect("/login");
}
