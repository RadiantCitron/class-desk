import { afterEach, describe, expect, it } from "vitest";
import {
  grantDiscordRole,
  revokeDiscordRole,
  setDiscordRoleClientForTest,
} from "./bot";
import { createMockDiscordRoleClient } from "./mock-role-client";

// 실 Discord env·HTTP 없이 역할 부여/회수 성공·실패만 검증한다.
describe("디스코드 역할 클라이언트 mock", () => {
  afterEach(() => {
    setDiscordRoleClientForTest(null);
  });

  it("mode success면 grant·revoke가 resolve한다", async () => {
    setDiscordRoleClientForTest(createMockDiscordRoleClient({ mode: "success" }));
    await expect(grantDiscordRole("user-1", "role-1")).resolves.toBeUndefined();
    await expect(revokeDiscordRole("user-1", "role-1")).resolves.toBeUndefined();
  });

  it("mode failure면 grant·revoke가 reject한다", async () => {
    setDiscordRoleClientForTest(
      createMockDiscordRoleClient({ mode: "failure", failureMessage: "mock boom" }),
    );
    await expect(grantDiscordRole("user-1", "role-1")).rejects.toThrow("mock boom");
    await expect(revokeDiscordRole("user-1", "role-1")).rejects.toThrow("mock boom");
  });
});
