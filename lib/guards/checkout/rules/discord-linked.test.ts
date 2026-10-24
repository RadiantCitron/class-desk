import { describe, it, expect } from "vitest";
import { discordLinked } from "./discord-linked";
import { makeContext } from "./test-helpers";

describe("DISCORD_LINKED — 디스코드 강의는 디스코드 연결 후 결제", () => {
  it("디스코드 강의 + 미연결이면 거부", () => {
    expect(discordLinked.evaluate(makeContext({ requiresDiscord: true, user: { discordLinked: false } }))).toBe(false);
  });
  it("디스코드 강의 + 연결됨이면 통과", () => {
    expect(discordLinked.evaluate(makeContext({ requiresDiscord: true, user: { discordLinked: true } }))).toBe(true);
  });
  it("디스코드 없는 품목은 연결 여부와 무관하게 통과", () => {
    expect(discordLinked.evaluate(makeContext({ requiresDiscord: false, user: { discordLinked: false } }))).toBe(true);
  });
});
