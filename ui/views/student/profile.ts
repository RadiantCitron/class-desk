import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/supabase/relations";
import { runQuery } from "@/lib/commands/run-command";

export type ProfileView = {
  linkedBanner: boolean;
  linkErrorMessage: string | null;
  /** 디스코드 서버 자동 입장 실패 안내. inviteUrl이 있으면 초대링크를 보여 준다. */
  joinError: { inviteUrl: string | null } | null;
  discordId: string | null;
  email: string;
  form: {
    name: string;
    phone: string;
    gender: string;
    birthDate: string;
    note: string;
    marketingOptIn: boolean;
  };
  /** 탈퇴하면 함께 취소될 신청·수강 건수(PENDING·APPROVED). */
  activeOrderCount: number;
  /** 결제 완료(PAID/PARTIALLY_REFUNDED) 상태인 신청 건수 */
  paidOrderCount: number;
  /** 활성 신청 상세 목록 */
  activeOrders: Array<{ id: string; title: string; isPaid: boolean; paymentStatus: string }>;
};

// "내 정보" 화면 — 대시보드에서 분리해 별도 경로로 둔다.
export async function loadProfile(input: {
  link_error?: string;
  linked?: string;
  join_error?: string;
}): Promise<ProfileView> {
  return runQuery({ command: "STUDENT_PROFILE_VIEW" }, async (authProfile) => {
    const supabase = await createClient();

    // email은 Profile 타입에 이미 있지만, name/phone/gender/birth_date/note는 편집 폼 전용 컬럼이라 별도 조회한다.
    // discord_id는 2026-09-27부터 users가 아니라 discord_accounts에서 온다(디스코드가 로그인 수단이 아니라 채팅방 입장 전용 이용권 정보로 내려갔기 때문).
    const { data: profile } = await supabase
      .from("users")
      .select(
        "email, name, phone, gender, birth_date, note, marketing_email_opt_in, discord_accounts(discord_id)",
      )
      .eq("id", authProfile.id)
      .maybeSingle();
    const discordId = one(profile?.discord_accounts)?.discord_id ?? null;

    // 탈퇴 경고문에 쓸 목록 — 결제 전 신청도 탈퇴 시 함께 취소되므로 PENDING·APPROVED 둘 다 센다.
    // 결제 완료/부분환불 건은 별도 경고 및 체크박스를 요구한다.
    const { data: orderRows } = await supabase
      .from("orders")
      .select("id, status, payment_status, final_amount, course_offerings(label, courses(name))")
      .eq("user_id", authProfile.id)
      .in("status", ["PENDING", "APPROVED"]);

    const activeOrders = (orderRows ?? []).map((o) => {
      const off = one(o.course_offerings);
      const c = one(off?.courses);
      const title = `${c?.name ?? "수업"}${off?.label ? ` (${off.label})` : ""}`;
      const isPaid = o.payment_status === "PAID" || o.payment_status === "PARTIALLY_REFUNDED";
      return { id: o.id, title, isPaid, paymentStatus: o.payment_status };
    });

    const activeOrderCount = activeOrders.length;
    const paidOrderCount = activeOrders.filter((o) => o.isPaid).length;

    return {
      linkedBanner: !!input.linked,
      linkErrorMessage: input.link_error
        ? input.link_error === "discord_in_use"
          ? "이 디스코드 계정은 이미 다른 회원 계정에 연결되어 있습니다. 그 계정으로 로그인하세요."
          : "디스코드 연결에 실패했습니다. 다시 시도해 주세요."
        : null,
      joinError: input.join_error ? { inviteUrl: process.env.DISCORD_INVITE_URL || null } : null,
      discordId,
      email: profile?.email ?? "",
      form: {
        name: profile?.name ?? "",
        phone: profile?.phone ?? "",
        gender: profile?.gender ?? "UNSPECIFIED",
        birthDate: profile?.birth_date ?? "",
        note: profile?.note ?? "",
        marketingOptIn: profile?.marketing_email_opt_in ?? false,
      },
      activeOrderCount,
      paidOrderCount,
      activeOrders,
    };
  });
}
