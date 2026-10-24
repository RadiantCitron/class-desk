import { describe, it, expect, vi, beforeEach } from "vitest";

const insertMock = vi.fn(async () => ({ error: null }));
let existingUnresolved: { id: string } | null = null;

// admin.from("dead_letters").select(...).eq(...).eq(...).contains(...).limit(1).maybeSingle()
// 과 admin.from("dead_letters").insert(...) 둘 다 지원하는 최소 체이닝 목.
function fakeAdminClient() {
  return {
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            contains: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: existingUnresolved, error: null }),
              }),
            }),
          }),
        }),
      }),
      insert: insertMock,
    }),
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeAdminClient(),
}));

import { reportAuditFailure } from "./failure";

const record = {
  actorProfileId: "user-1",
  action: "SYSTEM_GATE_SET",
  targetTable: "system_gates",
  phase: "SUCCEEDED" as const,
  correlationId: "corr-1",
};

describe("reportAuditFailure() — 감사 기록 실패를 DLQ에 남긴다", () => {
  beforeEach(() => {
    insertMock.mockReset().mockResolvedValue({ error: null });
    existingUnresolved = null;
  });

  it("미해결 경고가 없으면 dead_letters에 source=AUDIT으로 적재한다", async () => {
    await reportAuditFailure(record, new Error("DB 장애"));

    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "AUDIT",
        payload: expect.objectContaining({ action: "SYSTEM_GATE_SET" }),
        error_message: expect.stringContaining("SYSTEM_GATE_SET"),
      }),
    );
  });

  it("같은 action의 미해결 경고가 이미 있으면 중복 적재하지 않는다(폭주 방지)", async () => {
    existingUnresolved = { id: "existing-1" };

    await reportAuditFailure(record, new Error("DB 장애"));

    expect(insertMock).not.toHaveBeenCalled();
  });

  it("DLQ 적재 자체가 실패해도 throw하지 않는다(최종 방어선)", async () => {
    insertMock.mockRejectedValueOnce(new Error("DLQ도 죽음"));

    await expect(reportAuditFailure(record, new Error("원래 에러"))).resolves.toBeUndefined();
  });
});
