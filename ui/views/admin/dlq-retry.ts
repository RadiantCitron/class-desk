// DLQ(OUTBOX) 행에 「재시도」 폼을 낼지 판정한다(2026-10-08 S-2).
// reset_dead_outbox_message()는 dead_at이 찍힌(10회를 다 쓴) 메시지만 되살린다 — 그 전 행에 폼을 내면
// 누르는 순간 「이미 처리됐거나 죽은 상태가 아닌 메시지입니다.」 오류가 났다. 폼은 죽은 메시지에만,
// 나머지는 지금 상태를 한 줄로 알린다.

export type OutboxMessageState = {
  attempts: number;
  dead_at: string | null;
  processed_at: string | null;
};

export type OutboxRetryDisplay = {
  /** 죽은 메시지일 때만 — 재시도 폼에 쓴다. */
  retryableMessageId: string | null;
  /** 폼을 내지 않을 때 관리자에게 보여 줄 상태 한 줄. */
  note: string | null;
};

export function outboxRetryDisplay(messageId: string | null, message: OutboxMessageState | null): OutboxRetryDisplay {
  if (!messageId) return { retryableMessageId: null, note: null };
  if (!message) return { retryableMessageId: null, note: "아웃박스 메시지를 찾을 수 없습니다 — 확인 후 처리 완료로 표시하세요." };
  if (message.processed_at) {
    return { retryableMessageId: null, note: "이후 처리 완료된 메시지입니다 — 확인 후 처리 완료로 표시하세요." };
  }
  if (message.dead_at) return { retryableMessageId: messageId, note: null };
  return {
    retryableMessageId: null,
    note: `자동 재시도 중(${message.attempts}회 시도) — 원인을 고친 뒤 기다리거나 /admin/system 「아웃박스 수동 처리」를 쓰세요. 「재시도」는 자동 재시도를 다 쓴 메시지에만 나옵니다.`,
  };
}
