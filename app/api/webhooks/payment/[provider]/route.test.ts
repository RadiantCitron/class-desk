import { describe, it, expect, vi, beforeEach } from "vitest";

const insertMock = vi.fn(async () => ({ error: null as { message: string } | null }));
const ingestWebhookMock = vi.fn();
const runOutboxBatchMock = vi.fn(async () => undefined);

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: insertMock,
    }),
  }),
}));

vi.mock("@/lib/payment", () => ({
  ingestWebhook: (...args: unknown[]) => ingestWebhookMock(...args),
  providerNameFromUrlSegment: (segment: string) =>
    segment === "toss" ? "TOSS" : null,
  PaymentWebhookError: class PaymentWebhookError extends Error {
    source: string;
    payload: unknown;
    retryable: boolean;
    authFailure: boolean;
    constructor(
      source: string,
      payload: unknown,
      message: string,
      opts?: { retryable?: boolean; authFailure?: boolean },
    ) {
      super(message);
      this.source = source;
      this.payload = payload;
      this.retryable = opts?.retryable ?? false;
      this.authFailure = opts?.authFailure ?? false;
    }
  },
}));

vi.mock("@/lib/wiring/outbox", () => ({
  runOutboxBatch: () => runOutboxBatchMock(),
}));

import { POST } from "./route";

function makeRequest(body = "raw"): Request {
  return new Request("http://127.0.0.1/api/webhooks/payment/toss", {
    method: "POST",
    body,
  });
}

describe("결제 웹훅 라우트 — F-1 DLQ 실패 시 5xx", () => {
  beforeEach(() => {
    insertMock.mockReset().mockResolvedValue({ error: null });
    ingestWebhookMock.mockReset();
    runOutboxBatchMock.mockReset().mockResolvedValue(undefined);
  });

  it("알 수 없는 PG 경로(폐기된 payapp 포함)는 404이고 수신·DLQ·드레인을 하지 않는다", async () => {
    for (const provider of ["payapp", "unknown"]) {
      const res = await POST(makeRequest(), { params: Promise.resolve({ provider }) });
      expect(res.status).toBe(404);
    }
    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(runOutboxBatchMock).not.toHaveBeenCalled();
  });

  it("건별 실패 + DLQ 적재 실패면 500을 돌려주고 ack·드레인을 하지 않는다", async () => {
    ingestWebhookMock.mockResolvedValue({
      failures: [{ raw: { x: 1 }, message: "원장 기록 실패" }],
      ack: { status: 200, body: "SUCCESS" },
    });
    insertMock.mockResolvedValue({ error: { message: "DLQ down" } });

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ provider: "toss" }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ ok: false });
    expect(runOutboxBatchMock).not.toHaveBeenCalled();
  });

  it("건별 실패여도 DLQ 적재에 성공하면 어댑터 ack를 그대로 돌려준다", async () => {
    ingestWebhookMock.mockResolvedValue({
      failures: [{ raw: { x: 1 }, message: "원장 기록 실패" }],
      ack: { status: 200, body: "SUCCESS" },
    });

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ provider: "toss" }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("SUCCESS");
    expect(runOutboxBatchMock).toHaveBeenCalledOnce();
  });

  it("failures가 비어 있으면 드레인 후 ack", async () => {
    ingestWebhookMock.mockResolvedValue({
      failures: [],
      ack: { status: 200, body: "OK" },
    });

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ provider: "toss" }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    expect(insertMock).not.toHaveBeenCalled();
    expect(runOutboxBatchMock).toHaveBeenCalledOnce();
  });

  it("인증 실패는 DLQ 없이 401", async () => {
    const { PaymentWebhookError } = await import("@/lib/payment");
    ingestWebhookMock.mockRejectedValue(
      new PaymentWebhookError("TOSS", {}, "웹훅 인증 실패", { authFailure: true }),
    );

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ provider: "toss" }),
    });

    expect(res.status).toBe(401);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("재시도 가능 오류는 DLQ 적재에 성공해도 500", async () => {
    const { PaymentWebhookError } = await import("@/lib/payment");
    ingestWebhookMock.mockRejectedValue(
      new PaymentWebhookError("TOSS", { x: 1 }, "토스 결제 조회 실패: 502", { retryable: true }),
    );

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ provider: "toss" }),
    });

    expect(res.status).toBe(500);
    expect(insertMock).toHaveBeenCalledOnce();
  });

  it("본문이 64KB 초과면 413", async () => {
    const big = "x".repeat(65 * 1024);
    const res = await POST(makeRequest(big), {
      params: Promise.resolve({ provider: "toss" }),
    });
    expect(res.status).toBe(413);
    expect(ingestWebhookMock).not.toHaveBeenCalled();
  });
});
