import { describe, expect, it } from "vitest";
import { attemptRefOf, resultForAttempt } from "./attempt-result";

// 대사 ⑦과 관리자 "결제 요청 이력"이 시도 단위로 결과를 잇는지.
const A = { id: "aaaaaaaa-1111-4111-8111-111111111111", confirm_requested_at: "2026-10-02T10:00:00.000+00:00" };
const B = { id: "bbbbbbbb-2222-4222-8222-222222222222", confirm_requested_at: "2026-10-02T10:05:00.000+00:00" };

describe("결제 시도 ↔ 결과 매칭", () => {
  it("승인 응답이 유실된 시도 A는, 같은 주문의 시도 B가 성공해도 해결로 보지 않는다(예전 주문 단위 판정의 구멍)", () => {
    const events = [
      { event_type: "PAYMENT_SUCCEEDED", created_at: "2026-10-02T10:05:02.000+00:00", metadata: { attempt_ref: B.id } },
    ];
    expect(resultForAttempt(A, events)).toBeUndefined();
    expect(resultForAttempt(B, events)?.event_type).toBe("PAYMENT_SUCCEEDED");
  });

  it("웹훅이 남긴 시도 앞부분(8자리)으로도 잇는다", () => {
    const events = [
      { event_type: "PAYMENT_SUCCEEDED", created_at: "2026-10-02T10:00:03.000+00:00", metadata: { attempt_ref: "aaaaaaaa" } },
    ];
    expect(resultForAttempt(A, events)).toBeDefined();
    expect(resultForAttempt(B, events)).toBeUndefined();
  });

  it("attempt_ref 없는 결과(규칙 전 행·수동 확정)는 승인 요청 시각 이후면 그 시도의 결과로 본다", () => {
    const events = [{ event_type: "PAYMENT_SUCCEEDED", created_at: "2026-10-02T10:01:00.000+00:00", metadata: {} }];
    expect(resultForAttempt(A, events)).toBeDefined();
    expect(resultForAttempt(B, events)).toBeUndefined(); // B의 승인 요청보다 이르다
  });

  it("승인을 요청하지 않은 시도·결과가 아닌 이벤트·승인 요청 전 결과는 잇지 않는다", () => {
    const events = [
      { event_type: "REFUNDED", created_at: "2026-10-02T10:10:00.000+00:00", metadata: { attempt_ref: A.id } },
      { event_type: "PAYMENT_FAILED", created_at: "2026-10-02T09:59:59.999+00:00", metadata: { attempt_ref: A.id } },
    ];
    expect(resultForAttempt(A, events)).toBeUndefined();
    expect(resultForAttempt({ id: A.id, confirm_requested_at: null }, events)).toBeUndefined();
  });

  it("여러 결과가 있으면 가장 먼저 생긴 것을 고른다", () => {
    const events = [
      { event_type: "PAYMENT_SUCCEEDED", created_at: "2026-10-02T10:00:09.000+00:00", metadata: { attempt_ref: A.id } },
      { event_type: "PAYMENT_FAILED", created_at: "2026-10-02T10:00:01.000+00:00", metadata: { attempt_ref: A.id } },
    ];
    expect(resultForAttempt(A, events)?.event_type).toBe("PAYMENT_FAILED");
  });

  it("metadata가 비었거나 형식이 다르면 attempt_ref 없음", () => {
    expect(attemptRefOf(null)).toBeNull();
    expect(attemptRefOf({ attempt_ref: "" })).toBeNull();
    expect(attemptRefOf({ attempt_ref: 1 })).toBeNull();
    expect(attemptRefOf({ attempt_ref: "abc" })).toBe("abc");
  });
});
