import type { EligibilityRule } from "../types";

// 디스코드 역할을 주는 강의(grants에 DISCORD_ROLE)는 디스코드를 연결해야 결제할 수 있다 — 연결 없이
// 결제하면 역할을 줄 곳이 없다. 물품·디스코드 없는 강의는 해당 없음.
// 판정 기준은 lib/guards/discord-linked.ts의 isDiscordLinked와 같다.
// 신청 단계는 디스코드 미연결이어도 허용되고, 결제 시작 및 복귀 확정 직전(UNPAID)에 이 규칙으로 차단한다.
export const discordLinked: EligibilityRule = {
  code: "DISCORD_LINKED",
  message: "디스코드에서 진행하는 강의입니다. 내 정보에서 디스코드 계정을 먼저 연결해 주세요.",
  evaluate: (ctx) => !ctx.requiresDiscord || ctx.user.discordLinked,
};
