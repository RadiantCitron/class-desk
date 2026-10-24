import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { one } from "@/lib/supabase/relations";
import { formatAccessCode } from "@/lib/entitlements/accessCode";
import { runQuery } from "@/lib/commands/run-command";

const TYPE_LABELS: Record<string, string> = {
  COURSE_ACCESS: "수강 접근권",
  SOURCE_DOWNLOAD: "소스코드 다운로드권",
  DISCORD_ROLE: "디스코드 역할",
};

const DISCORD_STATUS_LABELS: Record<"GRANTED" | "PENDING" | "FAILED", string> = {
  GRANTED: "디스코드 역할 부여 완료",
  PENDING: "디스코드 역할 부여 처리 중",
  FAILED: "디스코드 역할 부여 실패(재시도 중 — 문제가 계속되면 문의해 주세요)",
};

export type EntitlementItemView = {
  id: string;
  typeLabel: string;
  courseName: string | null;
  /** DISCORD_ROLE 이용권의 부여 상태. tone으로 색을 고른다. */
  discord: { text: string; tone: "granted" | "failed" | "pending" } | null;
  /** "코드: XXXX-XXXX" */
  codeText: string;
  /** "부여: … · 만료: … · 사용 n/m회 · 회수됨" 한 줄(원본과 같은 조립). */
  grantedText: string;
  /** 하단 영역: 다운로드 버튼 / 안내 문구 / 상태 문구(+디스코드 채널 링크). */
  footer:
    | { kind: "download"; href: string }
    | { kind: "note"; text: string }
    | { kind: "status"; text: string; channelUrl: string | null };
};

export type EntitlementsView =
  | { kind: "restricted"; message: string }
  | { kind: "ok"; items: EntitlementItemView[] };

// 결제 완료 시 자동으로 부여되는 권한을 학생이 볼 수 있는 화면이다. SOURCE_DOWNLOAD(소모형)만 /api/downloads/{id}로 실제로 "쓴다" — Blob 주소는 화면에 나오지 않는다.
// COURSE_ACCESS·DISCORD_ROLE(자격형)은 보유 여부만 뜻이 있다(6단계, 2026-09-23 D12).
export async function loadEntitlements(): Promise<EntitlementsView> {
  // 조회 통제(시스템·이용권 모듈·이 화면·이 학생 대상 스위치, 옛 학생 VIEW 제한 포함 — 명령 레일 CR-5)에 걸리면 쿼리 이전에 반환해
  // entitlements/entitlement_uses/outbox 조회 자체를 스킵한다.
  return runQuery<"STUDENT_ENTITLEMENTS_VIEW", EntitlementsView>({ command: "STUDENT_ENTITLEMENTS_VIEW", onDenied: (denial) => ({ kind: "restricted", message: denial.message }) }, async (profile) => {
    const supabase = await createClient();

    // course_offerings.grants도 같이 가져온다 — DISCORD_ROLE 항목의 discord_channel_id(2026-09-27)로 학생에게 채널 딥링크를 보여주기 위함.
    const { data: entitlements } = await supabase
      .from("entitlements")
      .select(
        "id, type, access_code, metadata, grant_source, payment_event_id, grant_event_id, granted_at, expires_at, max_uses, revoked_at, orders(course_offerings(label, courses(name), grants))",
      )
      .eq("user_id", profile.id)
      .order("granted_at", { ascending: false });

    const { data: uses } = await supabase
      .from("entitlement_uses")
      .select("entitlement_id, used_at")
      .in("entitlement_id", entitlements?.map((e) => e.id) ?? []);

    const useCountByEntitlement = new Map<string, number>();
    uses?.forEach((u) => {
      useCountByEntitlement.set(u.entitlement_id, (useCountByEntitlement.get(u.entitlement_id) ?? 0) + 1);
    });

    // 디스코드 역할이 걸린 entitlement의 실제 부여 상태 — entitlements 행 자체는 디스코드 API 호출이 성공했는지 모른다. ORDER_PAID 아웃박스 메시지의 처리 상태로 판단한다.
    // outbox_messages는 관리자만 조회 가능한 테이블이라(RLS) admin 클라이언트로 조회하되, 학생에게는 status 한 단어만 보여주고 원문 에러 메시지는 노출하지 않는다.
    const discordStatusByEntitlement = new Map<string, "GRANTED" | "PENDING" | "FAILED">();
    const admin = createAdminClient();
    for (const ent of entitlements ?? []) {
      const roleId = (ent.metadata as { discord_role_id?: string } | null)?.discord_role_id;
      if (ent.type !== "DISCORD_ROLE" || !roleId) continue;

      // 부여 근거 종류에 따라 그 부여를 일으킨 사실(아웃박스 메시지)이 다르다 — 결제는 ORDER_PAID, 직권 부여는 ORDER_ACCESS_GRANTED.
      const source =
        ent.grant_source === "ADMIN_GRANT"
          ? { topic: "ORDER_ACCESS_GRANTED", key: "grant_event_id", id: ent.grant_event_id }
          : { topic: "ORDER_PAID", key: "payment_event_id", id: ent.payment_event_id };
      if (!source.id) continue;

      const { data: outboxMessage } = await admin
        .from("outbox_messages")
        .select("processed_at, attempts")
        .eq("topic", source.topic)
        .eq(`payload->>${source.key}`, source.id)
        .maybeSingle();

      if (outboxMessage?.processed_at) {
        discordStatusByEntitlement.set(ent.id, "GRANTED");
      } else if ((outboxMessage?.attempts ?? 0) > 0) {
        discordStatusByEntitlement.set(ent.id, "FAILED");
      } else {
        discordStatusByEntitlement.set(ent.id, "PENDING");
      }
    }

    const items: EntitlementItemView[] = (entitlements ?? []).map((ent) => {
      const usedCount = useCountByEntitlement.get(ent.id) ?? 0;
      const expired = !!ent.expires_at && new Date(ent.expires_at) < new Date();
      const exhausted = ent.max_uses !== null && usedCount >= ent.max_uses;
      const usable = !ent.revoked_at && !expired && !exhausted;
      const courseName = one(one(one(ent.orders)?.course_offerings)?.courses)?.name;
      const discordStatus = discordStatusByEntitlement.get(ent.id);
      const blobPathname = (ent.metadata as { blob_pathname?: string } | null)?.blob_pathname;
      const isDownload = ent.type === "SOURCE_DOWNLOAD";
      const downloadReady = isDownload && !!blobPathname;

      // 채널 딥링크(2026-09-27) — course_offerings.grants의 discord_channel_id(선택)와 시스템 전체 서버(DISCORD_GUILD_ID) 조합. 역할이 실제로 부여된 뒤에만 보여준다.
      const offeringGrants = one(one(ent.orders)?.course_offerings)?.grants as
        | { type: string; discord_channel_id?: string }[]
        | null;
      const discordChannelId = offeringGrants?.find((g) => g.type === "DISCORD_ROLE")?.discord_channel_id;
      const discordChannelUrl =
        ent.type === "DISCORD_ROLE" && discordStatus === "GRANTED" && discordChannelId && process.env.DISCORD_GUILD_ID
          ? `https://discord.com/channels/${process.env.DISCORD_GUILD_ID}/${discordChannelId}`
          : null;

      const stateText = usable ? "보유 중" : expired ? "만료됨" : exhausted ? "사용 완료" : "회수됨";

      let footer: EntitlementItemView["footer"];
      if (isDownload) {
        footer =
          usable && downloadReady
            ? { kind: "download", href: `/api/downloads/${ent.id}` }
            : {
                kind: "note",
                text:
                  usable && !downloadReady
                    ? "파일이 아직 준비되지 않았습니다."
                    : expired
                      ? "만료됨"
                      : exhausted
                        ? "사용 완료"
                        : "회수됨",
              };
      } else {
        footer = { kind: "status", text: stateText, channelUrl: discordChannelUrl };
      }

      return {
        id: ent.id,
        typeLabel: TYPE_LABELS[ent.type] ?? ent.type,
        courseName: courseName ?? null,
        discord: discordStatus
          ? {
              text: DISCORD_STATUS_LABELS[discordStatus],
              tone: discordStatus === "GRANTED" ? "granted" : discordStatus === "FAILED" ? "failed" : "pending",
            }
          : null,
        codeText: `코드: ${formatAccessCode(ent.access_code)}`,
        grantedText: `부여: ${new Date(ent.granted_at).toLocaleString("ko-KR")}${
        ent.expires_at ? ` · 만료: ${new Date(ent.expires_at).toLocaleDateString("ko-KR")}` : ""
      }${ent.max_uses !== null ? ` · 사용 ${usedCount}/${ent.max_uses}회` : ""}${ent.revoked_at ? " · 회수됨" : ""}`,
        footer,
      };
    });

    return { kind: "ok", items };
  });
}
