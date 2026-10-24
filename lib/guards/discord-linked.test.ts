import { describe, expect, it } from "vitest";
import {
  isDiscordLinked,
  offeringRequiresDiscord,
} from "./discord-linked";

describe("isDiscordLinked", () => {
  it("null·undefined·빈 문자열은 미연결", () => {
    expect(isDiscordLinked(null)).toBe(false);
    expect(isDiscordLinked(undefined)).toBe(false);
    expect(isDiscordLinked("")).toBe(false);
  });

  it("비어 있지 않은 문자열은 연결됨", () => {
    expect(isDiscordLinked("123456789012345678")).toBe(true);
  });
});

describe("offeringRequiresDiscord — 온라인(디스코드) 수업 판정(R-8)", () => {
  it("역할 ID가 있는 DISCORD_ROLE grant가 있으면 true", () => {
    expect(
      offeringRequiresDiscord([{ type: "COURSE_ACCESS" }, { type: "DISCORD_ROLE", discord_role_id: "123" }]),
    ).toBe(true);
  });

  it("DISCORD_ROLE이 없거나 역할 ID가 비면 false", () => {
    expect(offeringRequiresDiscord([{ type: "COURSE_ACCESS" }])).toBe(false);
    expect(offeringRequiresDiscord([{ type: "DISCORD_ROLE", discord_role_id: "" }])).toBe(false);
    expect(offeringRequiresDiscord([{ type: "DISCORD_ROLE" }])).toBe(false);
  });

  it("grants가 배열이 아니거나 이상한 값이면 false(안전한 쪽 — 디스코드 요구 안 함)", () => {
    expect(offeringRequiresDiscord(null)).toBe(false);
    expect(offeringRequiresDiscord(undefined)).toBe(false);
    expect(offeringRequiresDiscord({})).toBe(false);
    expect(offeringRequiresDiscord([null, 1, "x"])).toBe(false);
  });
});
