import type { DiscordRoleClient } from "./types";

/** 실 Discord HTTP 없이 역할 부여/회수 성공·실패만 흉내 낸다. */
export function createMockDiscordRoleClient(options: {
  mode: "success" | "failure";
  failureMessage?: string;
}): DiscordRoleClient {
  return {
    async grantRole() {
      if (options.mode === "failure") {
        throw new Error(options.failureMessage ?? "mock discord grant failed");
      }
    },
    async revokeRole() {
      if (options.mode === "failure") {
        throw new Error(options.failureMessage ?? "mock discord revoke failed");
      }
    },
  };
}
