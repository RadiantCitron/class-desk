import { describe, it, expect } from "vitest";
import { outboxRetryDisplay } from "./dlq-retry";

// S-2(2026-10-08): DLQ 「재시도」 폼은 죽은(dead_at) 아웃박스 메시지에만 — 그 전 행에서 누르면 오류였다.
describe("DLQ 재시도 폼 표시 판정", () => {
  it("OUTBOX가 아닌 행(메시지 id 없음)은 폼도 안내도 없다", () => {
    expect(outboxRetryDisplay(null, null)).toEqual({ retryableMessageId: null, note: null });
  });

  it("죽은 메시지면 폼을 낸다", () => {
    const r = outboxRetryDisplay("m1", { attempts: 10, dead_at: "2026-10-08T00:00:00Z", processed_at: null });
    expect(r).toEqual({ retryableMessageId: "m1", note: null });
  });

  it("자동 재시도 중이면 폼 대신 시도 횟수 안내", () => {
    const r = outboxRetryDisplay("m1", { attempts: 3, dead_at: null, processed_at: null });
    expect(r.retryableMessageId).toBeNull();
    expect(r.note).toContain("자동 재시도 중(3회 시도)");
  });

  it("이후 처리 완료됐으면 폼 대신 처리 완료 안내", () => {
    const r = outboxRetryDisplay("m1", { attempts: 1, dead_at: null, processed_at: "2026-10-08T00:00:00Z" });
    expect(r.retryableMessageId).toBeNull();
    expect(r.note).toContain("처리 완료된 메시지");
  });

  it("메시지를 찾지 못하면 폼 대신 안내", () => {
    const r = outboxRetryDisplay("m1", null);
    expect(r.retryableMessageId).toBeNull();
    expect(r.note).toContain("찾을 수 없습니다");
  });
});
