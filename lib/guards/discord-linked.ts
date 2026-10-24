/**
 * 온라인(디스코드) 수업인가 — 개설강의 `grants`에 역할 ID가 있는 `DISCORD_ROLE`이 있으면 true.
 * "온라인 수업"은 별도 컬럼이 아니라 이 판정이 정본이다(R-8, 2026-10-02: 신청·결제 단계와 개설·수정 폼이 모두 같은 규칙을 쓴다).
 */
export function offeringRequiresDiscord(grants: unknown): boolean {
  if (!Array.isArray(grants)) return false;
  return grants.some(
    (g) =>
      typeof g === "object" &&
      g !== null &&
      (g as { type?: unknown }).type === "DISCORD_ROLE" &&
      typeof (g as { discord_role_id?: unknown }).discord_role_id === "string" &&
      (g as { discord_role_id: string }).discord_role_id.length > 0,
  );
}

/** discord_accounts에 연결된 discord_id가 있으면 true */
export function isDiscordLinked(discordId: string | null | undefined): boolean {
  return typeof discordId === "string" && discordId.length > 0;
}
