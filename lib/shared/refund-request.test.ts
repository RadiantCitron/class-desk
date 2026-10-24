import { describe, expect, it } from "vitest";
import { evaluateRefund } from "./refund-policy";
import { describeSnapshot, findLastRejection, findOpenStudentRefundRequest, refundBlockedMessage, requestAgeDays, requestAgeLevel, studentProposalText, type OrderEventLike } from "./refund-request";


const ev = (id: string, event_type: string, created_at: string, payload: Record<string, unknown> | null = {}): OrderEventLike => ({ id, event_type, created_at, payload });
const req = (id: string, at = "2033-06-10T00:00:00Z") => ev(id, "REFUND_REQUESTED", at, { reason: "x" });
const rej = (id: string, requestId: string, at = "2033-06-11T00:00:00Z") => ev(id, "REFUND_REQUEST_REJECTED", at, { request_event_id: requestId, reason: "거절" });

describe("findOpenStudentRefundRequest", () => {
  it("신청이 없으면 null", () => {
    expect(findOpenStudentRefundRequest([ev("a", "APPLIED", "2033-06-01T00:00:00Z")], "APPROVED")).toBeNull();
  });
  it("거절되지 않은 신청이 열린 신청", () => {
    expect(findOpenStudentRefundRequest([req("r1")], "APPROVED")?.id).toBe("r1");
  });
  it("그 신청을 가리키는 거절이 있으면 닫힘, 거절 뒤 다시 신청하면 새 신청이 열림", () => {
    expect(findOpenStudentRefundRequest([req("r1"), rej("j1", "r1")], "APPROVED")).toBeNull();
    expect(findOpenStudentRefundRequest([req("r1"), rej("j1", "r1"), req("r2", "2033-06-12T00:00:00Z")], "APPROVED")?.id).toBe("r2");
  });
  it("다른 신청의 거절은 영향이 없다", () => {
    expect(findOpenStudentRefundRequest([req("r1"), rej("j1", "other")], "APPROVED")?.id).toBe("r1");
  });
  it("같은 시각의 이벤트도 id로 가리키므로 순서와 무관하다(시각 비교 안 함)", () => {
    const t = "2033-06-10T00:00:00Z";
    expect(findOpenStudentRefundRequest([rej("j1", "r1", t), req("r1", t)], "APPROVED")).toBeNull();
  });
  it("주문이 환불 등으로 CANCELLED가 되면 신청도 닫힘", () => {
    expect(findOpenStudentRefundRequest([req("r1")], "CANCELLED")).toBeNull();
  });
  it("열린 신청이 여럿이면 가장 최근", () => {
    expect(findOpenStudentRefundRequest([req("r1", "2033-06-10T00:00:00Z"), req("r2", "2033-06-12T00:00:00Z")], "APPROVED")?.id).toBe("r2");
  });
});

describe("findLastRejection", () => {
  it("열린 신청이 없고 거절이 있으면 가장 최근 거절, 열린 신청이 있으면 null", () => {
    expect(findLastRejection([req("r1"), rej("j1", "r1")], "APPROVED")?.id).toBe("j1");
    expect(findLastRejection([req("r1"), rej("j1", "r1"), req("r2", "2033-06-12T00:00:00Z")], "APPROVED")).toBeNull();
    expect(findLastRejection([], "APPROVED")).toBeNull();
    expect(findLastRejection([req("r1"), rej("j1", "r1")], "CANCELLED")).toBeNull();
  });
});

describe("경과일", () => {
  const now = new Date("2033-06-15T12:00:00Z");
  it("24시간 단위 내림", () => {
    expect(requestAgeDays("2033-06-15T11:00:00Z", now)).toBe(0);
    expect(requestAgeDays("2033-06-14T12:00:00Z", now)).toBe(1);
    expect(requestAgeDays("2033-06-12T12:00:01Z", now)).toBe(2);
    expect(requestAgeDays("2033-06-10T12:00:00Z", now)).toBe(5);
    expect(requestAgeDays("2033-06-16T12:00:00Z", now)).toBe(0);
  });
  it("3일 이상 주의, 5일 이상 경고", () => {
    expect([0, 2, 3, 4, 5, 9].map(requestAgeLevel)).toEqual(["NORMAL", "NORMAL", "WARN", "WARN", "ALERT", "ALERT"]);
  });
});

describe("학생 안내 문구", () => {
  const base = { paid: 10_000, refundable: 10_000, listPrice: 10_000, today: "2033-06-15", policyId: "2026-10-v1" };
  const day = (n: number) => ({ session_date: new Date(new Date("2033-06-15T00:00:00Z").getTime() + n * 86_400_000).toISOString().slice(0, 10), start_time: "10:00", end_time: "12:00" });
  it("개강 당일 하루짜리: 접수 경고 안내", () => {
    const blocked = evaluateRefund({ ...base, sessions: [day(0)] });
    const text = refundBlockedMessage(blocked);
    expect(text).toContain("약관상 환불 기준에 해당하지 않는 구간입니다");
    expect(text).toContain("신청은 접수되며 관리자가 검토해 결정합니다");
    expect(studentProposalText(blocked)).toBe(text);
  });
  it("회차 없음은 별도 안내", () => {
    expect(refundBlockedMessage(evaluateRefund({ ...base, sessions: [] }))).toContain("일정 정보를 확인할 수 없습니다");
  });
  it("가능하면 예상 환불액 문구(확정 아님)", () => {
    const ok = evaluateRefund({ ...base, sessions: [day(3)] });
    const text = studentProposalText(ok);
    expect(text).toContain("7,000원");
    expect(text).toContain("예상일 뿐");
    expect(text).toContain("관리자가 검토한 뒤 확정");
  });
});

describe("describeSnapshot (A-2 근거 문장 생성)", () => {
  it("스냅샷이 없거나 비어 있으면 제안 정보 없음", () => {
    expect(describeSnapshot(null)).toBe("신청 시점 제안 정보 없음");
    expect(describeSnapshot(undefined)).toBe("신청 시점 제안 정보 없음");
  });

  it("에러 또는 불가 구간 처리", () => {
    expect(describeSnapshot({ error: "오류 발생" })).toBe("제안 계산 오류: 오류 발생");
    expect(describeSnapshot({ eligible: false })).toBe("신청 시점에 약관상 환불 불가 구간");
    expect(describeSnapshot({ stage: "NOT_ALLOWED" })).toBe("신청 시점에 약관상 환불 불가 구간");
    expect(describeSnapshot({ stage: "NO_SESSIONS" })).toBe("신청 시점에 회차 정보 없음");
  });

  it("개강 전 구간 (일수, 비율, 금액, 정책 버전)", () => {
    const s = {
      policyId: "2026-10-v1",
      stage: "BEFORE_START",
      eligible: true,
      amount: 7000,
      daysBefore: 3,
      ratio: { n: 7, d: 10 },
      penalty: null,
    };
    expect(describeSnapshot(s)).toBe("7,000원 (개강 3일 전 · 70%) [정책 2026-10-v1]");
  });

  it("개강 후 구간 (경과 분, 위약금 차감)", () => {
    const s = {
      policyId: "2026-10-v1",
      stage: "AFTER_START",
      eligible: true,
      amount: 5666,
      daysBefore: null,
      elapsed: { pastMinutes: 120, totalMinutes: 480 },
      ratio: { n: 2, d: 3 },
      penalty: { n: 1, d: 10 },
    };
    expect(describeSnapshot(s)).toBe("5,666원 (경과 120/480분 · 2/3 · 위약금 10% 차감) [정책 2026-10-v1]");
  });
});

