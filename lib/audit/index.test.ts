import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuditRecord } from "./types";

// vi.mock 팩토리는 파일 최상단으로 호이스팅되므로, 그 안에서 쓸 목은 vi.hoisted()로
// 먼저 만들어야 한다(그냥 top-level const를 참조하면 "초기화 전 접근" 에러가 난다).
const { writeMock, reportAuditFailureMock, isAuditEnabledMock } = vi.hoisted(() => ({
  writeMock: vi.fn(async (_record: unknown) => {}),
  reportAuditFailureMock: vi.fn(async () => {}),
  isAuditEnabledMock: vi.fn(async () => true),
}));

vi.mock("./switch", () => ({
  isAuditEnabled: isAuditEnabledMock,
}));
vi.mock("./failure", () => ({
  reportAuditFailure: reportAuditFailureMock,
}));
vi.mock("./sinks/postgres", () => ({
  postgresSink: { name: "postgres", write: writeMock },
}));
vi.mock("./sinks/noop", () => ({
  noopSink: { name: "noop", write: vi.fn(async () => {}) },
}));

import { getAuditSink, recordAudit } from "./index";

type AuditWriteMock = (record: AuditRecord) => Promise<void>;
const typedWriteMock = writeMock as unknown as ReturnType<typeof vi.fn<AuditWriteMock>>;

const baseRecord = {
  actorProfileId: "user-1",
  action: "TEST_ACTION",
  targetTable: "some_table",
  phase: "SUCCEEDED" as const,
};

describe("getAuditSink() — AUDIT 게이트에 따라 postgres/noop을 고른다", () => {
  beforeEach(() => {
    isAuditEnabledMock.mockReset().mockResolvedValue(true);
  });

  it("감사가 켜져 있으면 postgres sink를 고른다", async () => {
    const sink = await getAuditSink();
    expect(sink.name).toBe("postgres");
  });

  it("감사가 꺼져 있으면(AUDIT 게이트 CLOSED) noop sink를 고른다", async () => {
    isAuditEnabledMock.mockResolvedValue(false);
    const sink = await getAuditSink();
    expect(sink.name).toBe("noop");
  });
});

describe("recordAudit() — 절대 throw하지 않는다(fail-open)", () => {
  beforeEach(() => {
    isAuditEnabledMock.mockReset().mockResolvedValue(true);
    typedWriteMock.mockReset().mockResolvedValue(undefined);
    reportAuditFailureMock.mockReset().mockResolvedValue(undefined);
  });

  it("정상 상황에서는 sink.write()를 호출한다", async () => {
    await recordAudit(baseRecord);
    expect(typedWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({ actorProfileId: "user-1", action: "TEST_ACTION" }),
    );
  });

  it("correlationId를 안 주면 새로 발급해서 sink에 넘긴다", async () => {
    await recordAudit(baseRecord);
    const written = typedWriteMock.mock.calls[0][0];
    expect(typeof written.correlationId).toBe("string");
    expect(written.correlationId?.length).toBeGreaterThan(0);
  });

  it("sink.write()가 실패해도 recordAudit()은 throw하지 않고 reportAuditFailure()로 넘긴다", async () => {
    const err = new Error("DB 장애");
    typedWriteMock.mockRejectedValueOnce(err);

    await expect(recordAudit(baseRecord)).resolves.toBeUndefined();
    expect(reportAuditFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "TEST_ACTION" }),
      err,
    );
  });

  it("sink를 명시적으로 넘기면 getAuditSink()를 다시 호출하지 않고 그 sink를 그대로 쓴다 — 명령 도중 AUDIT 게이트가 바뀌어도 같은 명령 안에서는 일관돼야 한다(2026-09-20 e2e로 발견: AUDIT을 끄는 명령 자체의 결과 기록이 사라지던 버그)", async () => {
    isAuditEnabledMock.mockClear();
    const explicitSink = { name: "explicit", write: vi.fn(async () => {}) };

    await recordAudit(baseRecord, explicitSink);

    expect(isAuditEnabledMock).not.toHaveBeenCalled();
    expect(explicitSink.write).toHaveBeenCalledWith(
      expect.objectContaining({ actorProfileId: "user-1" }),
    );
    expect(typedWriteMock).not.toHaveBeenCalled();
  });
});
