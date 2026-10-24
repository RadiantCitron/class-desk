import type { AuditSink } from "../types";

// 감사를 완전히 끈 상태의 구현체. /admin/system에서 AUDIT 게이트를 CLOSED로 바꾸면 이걸 쓴다.
// 아무것도 하지 않고 성공한 것처럼 반환한다 — 신청·결제 같은 업무 로직은 감사 여부와 무관하게
// 그대로 동작해야 하므로, 이 sink를 쓰는 동안에도 recordAudit() 호출부는 아무것도 바꿀 필요가
// 없다.
export const noopSink: AuditSink = {
  name: "noop",

  async write(): Promise<void> {
    // 의도적으로 비워 둠.
  },
};
