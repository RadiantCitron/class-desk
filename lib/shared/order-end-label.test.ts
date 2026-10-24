import { describe, expect, it } from "vitest";
import { orderEndLabel } from "./order-end-label";
import type { OrderEventLike } from "./refund-request";

const cancelled = (payload: Record<string, unknown>, at = "2033-06-15T00:00:00Z"): OrderEventLike => ({ id: "c", event_type: "CANCELLED", created_at: at, payload });
const closed: OrderEventLike = { id: "x", event_type: "CLOSED", created_at: "2033-06-16T00:00:00Z", payload: { mode: "NO_REFUND" } };

describe("orderEndLabel", () => {
  it("CANCELLED가 아니면 null", () => {
    expect(orderEndLabel("APPROVED", [cancelled({ cause: "ADMIN_REFUND", past_sessions: 0 })])).toBeNull();
    expect(orderEndLabel("PENDING", [])).toBeNull();
  });
  it("관리자·학생 환불: 지난 회차 0이면 미수강, 1 이상이면 수강중", () => {
    for (const cause of ["ADMIN_REFUND", "STUDENT_REFUND"]) {
      expect(orderEndLabel("CANCELLED", [cancelled({ cause, past_sessions: 0, total_sessions: 4 })])).toEqual({
        code: "ABANDON_BEFORE",
        label: "수강 포기(미수강)",
        fault: "STUDENT",
      });
      expect(orderEndLabel("CANCELLED", [cancelled({ cause, past_sessions: 1, total_sessions: 4 })])).toEqual({
        code: "ABANDON_DURING",
        label: "수강 포기(수강중)",
        fault: "STUDENT",
      });
      expect(orderEndLabel("CANCELLED", [cancelled({ cause, past_sessions: 4 })])?.code).toBe("ABANDON_DURING");
    }
  });
  it("지난 회차 기록이 없는 옛 사건(S-3 이전)은 구분 없이 「수강 포기」", () => {
    expect(orderEndLabel("CANCELLED", [cancelled({ cause: "ADMIN_REFUND" })])).toEqual({
      code: "ABANDON",
      label: "수강 포기",
      fault: "STUDENT",
    });
  });
  it("수강생이 그만둔 것이 아닌 종료는 「수강 포기」가 아니다", () => {
    expect(orderEndLabel("CANCELLED", [cancelled({ cause: "OFFERING_CANCELLED", past_sessions: 2 })])).toEqual({
      code: "OFFERING_CANCELLED",
      label: "폐강",
      fault: "OPERATOR",
    });
    expect(orderEndLabel("CANCELLED", [cancelled({ cause: "OPERATOR_REFUND", past_sessions: 1 })])).toEqual({
      code: "OPERATOR_REFUND",
      label: "운영 사정으로 환불",
      fault: "OPERATOR",
    });
    expect(orderEndLabel("CANCELLED", [cancelled({ cause: "EXTERNAL_REFUND", past_sessions: 0 })])).toEqual({
      code: "EXTERNAL_REFUND",
      label: "외부 환불로 종료",
      fault: "EXTERNAL",
    });
    expect(orderEndLabel("CANCELLED", [closed])).toEqual({
      code: "CLOSED",
      label: "폐강 종료(환불 없음)",
      fault: "OPERATOR",
    });
  });
  it("일정 변경으로 제외(환불이든 환불 없는 제외든)는 학생 귀책의 수강 포기(일정 변경)", () => {
    expect(orderEndLabel("CANCELLED", [cancelled({ cause: "SCHEDULE_CHANGE", past_sessions: 0, mode: "NO_REFUND" })])).toEqual({
      code: "SCHEDULE_CHANGE",
      label: "수강 포기(일정 변경)",
      fault: "STUDENT",
    });
    expect(orderEndLabel("CANCELLED", [cancelled({ cause: "SCHEDULE_CHANGE", past_sessions: 0, partial: false })])?.label).toBe("수강 포기(일정 변경)");
  });
  it("환불 없이 종료(CLOSED 사건)가 있으면 그 라벨이 우선", () => {
    expect(orderEndLabel("CANCELLED", [cancelled({ cause: "ADMIN_REFUND", past_sessions: 0 }), closed])?.code).toBe("CLOSED");
  });
  it("원인이 없거나 모르는 값, 사건 자체가 없는 CANCELLED(결제 전 취소·탈퇴 등)는 null → 기존 「취소」", () => {
    expect(orderEndLabel("CANCELLED", [])).toBeNull();
    expect(orderEndLabel("CANCELLED", [cancelled({})])).toBeNull();
    expect(orderEndLabel("CANCELLED", [cancelled({ cause: "WHATEVER" })])).toBeNull();
    expect(orderEndLabel("CANCELLED", [{ id: "c", event_type: "CANCELLED", created_at: "2033-06-15T00:00:00Z", payload: null }])).toBeNull();
  });
});
