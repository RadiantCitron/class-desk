"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { runCommand } from "@/lib/commands/run-command";
import { MARKETING_OPT_IN_TERMS_TYPE, getCurrentTerms } from "@/lib/terms";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";

// 학생 본인 행위 두 곳(updateProfile/withdraw)도 CS 명령 파이프라인(runCommand)을 거친다
// — 예전엔 관리자 전용 파이프라인을 못 써서 recordAudit을
// 직접 불렀다.

// 수정 가능 컬럼을 화이트리스트로 명시한다 — role/withdrawn_at/previous_email은 일반
// 프로필 수정 경로로 못 바꾸게 막는다. discord_id는 2026-09-27부터 애초에
// users 컬럼이 아니다(discord_accounts로 옮겨감 — link_discord_identity()로만 씀).
//
// runAction으로 감싼다 — 예전엔 그냥 throw new Error였다.
export async function updateProfile(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await runCommand(
      { command: "PROFILE_UPDATE", targetTable: "users" },
      async (actor) => {
        const admin = createAdminClient();

        const name = String(formData.get("name") ?? "").trim() || null;
        const phone = String(formData.get("phone") ?? "").trim() || null;
        const gender = String(formData.get("gender") ?? "UNSPECIFIED");
        const birthDate = String(formData.get("birth_date") ?? "") || null;
        const note = String(formData.get("note") ?? "").trim() || null;
        const marketingEmailOptIn = formData.get("marketing_email_opt_in") === "on";
        const next = {
          name,
          phone,
          gender,
          birth_date: birthDate,
          note,
          marketing_email_opt_in: marketingEmailOptIn,
        };

        // 무엇이 바뀌었는지만 감사로그에 남기고 값 자체는 안 남긴다(개인정보를 로그 테이블에
        // 한 벌 더 복제하지 않기 위함). 그러려면 UPDATE 전에 이전 값을 알아야 한다.
        const { data: before } = await admin
          .from("users")
          .select("name, phone, gender, birth_date, note, marketing_email_opt_in")
          .eq("id", actor.id)
          .single();

        const { error } = await admin.from("users").update(next).eq("id", actor.id);

        if (error) {
          throw new Error(`프로필 수정 실패: ${error.message}`);
        }

        // 마케팅 수신 동의를 새로 켠 경우(false→true)만 동의 이력을 남긴다(선택 동의,
        // 2026-09-26 구조 분리 — 끄는 쪽은 캐시 컬럼만 바꾸고 새 이력을 안 만든다. 철회
        // 시각은 이 액션의 PROFILE_UPDATE 감사로그 detail.changed로 이미 남는다).
        if (marketingEmailOptIn && !before?.marketing_email_opt_in) {
          const supabase = await createClient();
          const marketingTerms = await getCurrentTerms(supabase, MARKETING_OPT_IN_TERMS_TYPE);
          if (marketingTerms) {
            await admin
              .from("terms_agreements")
              .insert({ user_id: actor.id, terms_id: marketingTerms.id });
          }
        }

        const changed = before
          ? (Object.keys(next) as (keyof typeof next)[]).filter((key) => before[key] !== next[key])
          : (Object.keys(next) as (keyof typeof next)[]);

        return { result: null, targetId: actor.id, detail: { changed } };
      },
    );

    revalidatePath("/student/profile");
  });
}

// 탈퇴 = 소프트 탈퇴, DB 행 삭제 절대 금지.
// 본인 확인은 본인 이메일 재입력이다(2026-09-25 — 비밀번호가 없으므로 오조작
// 방지 목적의 재확인만 한다. 신원 자체는 이미 세션이 증명한다). 탈퇴 표시·회원 이벤트·
// USER_WITHDRAWN 사실은 withdraw_user() 한 트랜잭션이다.
//
// 이메일 오타는 학생이 직접 타이핑하는 유일한 폼이라
// 필연적으로 자주 일어난다 — ActionForm(components/ActionForm.tsx)과 짝을 이뤄 그 메시지를
// 화면에 그대로 보여준다. "탈퇴 처리 실패: {DB 에러}"는 내부 사정이 섞일 수 있어 그대로
// throw하고 error.tsx가 받는다.
export async function withdraw(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await runCommand(
      { command: "ACCOUNT_WITHDRAW", targetTable: "users" },
      async (actor) => {
        const confirmEmail = String(formData.get("confirm_email") ?? "").trim().toLowerCase();
        if (confirmEmail !== actor.email.toLowerCase()) {
          throw new UserFacingError("입력한 이메일이 본인 계정과 일치하지 않습니다.");
        }

        const admin = createAdminClient();

        // 진행 중 결제 수업 확인 (CS 가드)
        const { count: paidCount } = await admin
          .from("orders")
          .select("id", { count: "exact", head: true })
          .eq("user_id", actor.id)
          .in("status", ["PENDING", "APPROVED"])
          .in("payment_status", ["PAID", "PARTIALLY_REFUNDED"]);

        if ((paidCount ?? 0) > 0) {
          const confirmPaid = formData.get("confirm_paid_orders_cancel") === "on";
          if (!confirmPaid) {
            throw new UserFacingError("결제 완료된 수업의 취소 확인 체크박스에 동의해 주세요.");
          }
        }

        const { error } = await admin.rpc("withdraw_user", { p_user_id: actor.id });
        if (error) {
          throw new Error(`탈퇴 처리 실패: ${error.message}`);
        }

        return { result: null, targetId: actor.id };
      },
    );

    redirect("/withdrawn");
  });
}

// 디스코드 연결·입장 인증 시작(2026-09-27 guilds.join
// scope 추가). 수파인증의 수동 연결(linkIdentity)로 디스코드 승인 화면에 보내고, 돌아오면
// app/auth/callback/route.ts(next=link-discord)가 discord_accounts에 기록하고 이 scope로
// 받은 access_token으로 디스코드 채팅방(길드) 자동 추가까지 시도한다. 여기서는 DB를
// 쓰지 않는다(연결·입장 기록은 콜백의 link_discord_identity()/addGuildMember()).
export async function startDiscordLink() {
  // 연결 시작과 복귀 콜백은 같은 명령 DISCORD_LINK다 — 스위치로 막혀 있으면 디스코드로 보내기 전에 여기서 거부된다.
  const url = await runCommand({ command: "DISCORD_LINK", targetTable: "users" }, async (actor) => {
    const origin = (await headers()).get("origin") ?? "http://127.0.0.1:3000";
    const supabase = await createClient();
    const { data, error } = await supabase.auth.linkIdentity({
      provider: "discord",
      options: {
        redirectTo: `${origin}/auth/callback?next=link-discord`,
        scopes: "identify guilds.join",
      },
    });
    if (error || !data?.url) {
      throw new Error(`디스코드 연결을 시작하지 못했습니다: ${error?.message ?? "URL 없음"}`);
    }
    return { result: data.url, targetId: actor.id };
  });
  redirect(url);
}
