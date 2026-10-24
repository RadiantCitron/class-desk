// 디스코드 서버(길드) 역할 부여/회수 — "결제 확인한 사람만 정해진 방에 입장"을 위한 최소
// 구현("결제내역/entitlement를 확인해서 역할을 준다"). 실시간
// Gateway 연결이 필요한 "봇"이 아니라, 봇 계정 토큰으로 REST API 몇 개만 호출하면 된다 —
// 사람이 명령어를 치는 인터페이스는 없다(전부 결제/탈퇴/환불 이벤트에 자동으로 반응).
//
// 준비물(사용자가 디스코드에서 직접 해야 함)
// ① 개발자포털에서 봇 애플리케이션 생성 + 토큰 발급 ② 그 봇을 서버에 초대(역할 관리 권한 포함)
// ③ 서버 설정에서 역할 생성 + 봇의 역할을 그보다 위로 이동 ④ 채널 권한을 그 역할로 제한.
// 위 준비가 안 된 상태(DISCORD_GUILD_ID/DISCORD_BOT_TOKEN 미설정)에서는 호출이 실패해
// dead_letters(DLQ)에 기록만 되고, 다른 기능에는 영향이 없다(: "일단 기록만
// 철저히 해두면 된다").
//
// 검증되지 않은 부분: 아래 엔드포인트/헤더 형식은 Discord REST API v10 공개 문서 기준의
// 일반적인 형태다(다른 봇 구현체들이 널리 쓰는 방식) — 실제 서버 환경으로 착수할 때 공식
// 문서(discord.com/developers/docs)로 한 번 더 확인해야 한다(이 저장소의 기존 관례 —
// PayApp/스텝페이 스펙도 착수 시점에 재검증하기로 한 것과 동일).
//
// 역할 부여/회수는 DiscordRoleClient 포트 뒤로 둔다. 기본은 live
// (아래 createLiveDiscordRoleClient). 테스트는 setDiscordRoleClientForTest로 mock을 넣는다.
import type { DiscordRoleClient } from "./types";

const DISCORD_API_BASE = "https://discord.com/api/v10";

function requireEnv() {
  const guildId = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !botToken) {
    throw new Error("DISCORD_GUILD_ID/DISCORD_BOT_TOKEN이 설정되지 않았습니다.");
  }
  return { guildId, botToken };
}

async function callGuildMemberRoleApi(
  method: "PUT" | "DELETE",
  discordUserId: string,
  roleId: string,
) {
  const { guildId, botToken } = requireEnv();

  // 타임아웃 10초 — 디스코드가 느리면 결제 웹훅 응답까지 같이 묶였다.
  const res = await fetch(
    `${DISCORD_API_BASE}/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`,
    { method, headers: { Authorization: `Bot ${botToken}` }, signal: AbortSignal.timeout(10_000) },
  );

  // 회수(DELETE)의 404는 "뺄 대상이 이미 없음"(학생이 서버를 나감 = Unknown Member, 역할이 지워짐 =
  // Unknown Role)이라 목적은 이미 이뤄졌다 — 성공으로 본다. 예전엔 이걸 실패로 던져 회수 메시지가
  // 영원히 재시도됐다. 부여(PUT)의 404는 실제 실패라 그대로 던진다.
  if (method === "DELETE" && res.status === 404) {
    return;
  }

  // 204 No Content가 정상 응답(역할 부여/회수 둘 다) — 이미 있는 역할을 다시 주거나, 이미
  // 없는 역할을 다시 빼도 멱등하게 204로 끝난다(재시도 안전성의 근거).
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => "");
    const action = method === "PUT" ? "부여" : "회수";
    throw new Error(`디스코드 역할 ${action} 실패(HTTP ${res.status}): ${body}`);
  }
}

export function createLiveDiscordRoleClient(): DiscordRoleClient {
  return {
    grantRole: (discordUserId, roleId) => callGuildMemberRoleApi("PUT", discordUserId, roleId),
    revokeRole: (discordUserId, roleId) => callGuildMemberRoleApi("DELETE", discordUserId, roleId),
  };
}

let roleClient: DiscordRoleClient = createLiveDiscordRoleClient();

/** 테스트 전용 — 성공/실패 mock 주입. null이면 live로 복구. 운영에서는 거부. */
export function setDiscordRoleClientForTest(client: DiscordRoleClient | null) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("setDiscordRoleClientForTest는 테스트 전용입니다.");
  }
  roleClient = client ?? createLiveDiscordRoleClient();
}

export function grantDiscordRole(discordUserId: string, roleId: string) {
  return roleClient.grantRole(discordUserId, roleId);
}

export function revokeDiscordRole(discordUserId: string, roleId: string) {
  return roleClient.revokeRole(discordUserId, roleId);
}

// 디스코드 서버(길드) 자동 추가 — "디스코드 인증" 버튼을 누른 학생을 초대링크 클릭 없이
// 바로 길드에 넣는다(2026-09-27, Discord "Add Guild Member" API). accessToken은 그 학생이
// 방금 guilds.join scope로 동의한 OAuth access_token이다(app/auth/callback/route.ts가
// exchangeCodeForSession() 결과에서 지역 변수로만 꺼내 이 호출 한 번에 쓰고 버린다 — DB에
// 저장하지 않는다, 2026-09-27 대화 확정). 역할(roleId)은 여기서 넘기지 않는다 — 인증
// 시점엔 아직 지급된 이용권이 없는 게 정상 경로라, 역할 부여는 결제 후 grantDiscordRole()이
// 그대로 담당한다(이 학생은 이미 길드 멤버이므로 그 호출이 통한다).
//
// 검증되지 않은 부분: 위 나머지 함수와 같은 관례 — Add Guild Member(PUT /guilds/{guild.id}/
// members/{user.id})는 Discord REST API v10 문서 기준 형태이며, 실제 서버로 착수할 때
// 재확인한다.
export async function addGuildMember(discordUserId: string, accessToken: string) {
  const { guildId, botToken } = requireEnv();

  const res = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/members/${discordUserId}`, {
    method: "PUT",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: accessToken }),
    signal: AbortSignal.timeout(10_000),
  });

  // 201=새로 추가됨, 204=이미 멤버(멱등) — 둘 다 성공.
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => "");
    throw new Error(`디스코드 길드 자동추가 실패(HTTP ${res.status}): ${body}`);
  }
}
