import { createClient } from "@/lib/supabase/server";
import { runQuery } from "@/lib/commands/run-command";
import { outboxRetryDisplay, type OutboxMessageState } from "./dlq-retry";

export type AdminDlqView = {
  failures: {
    id: string;
    source: string;
    createdText: string;
    errorMessage: string;
    payloadJson: string;
    /** source가 OUTBOX이고 그 아웃박스 메시지가 죽었을(dead_at) 때만 — 재시도 폼(2026-10-08 S-2). */
    outboxMessageId: string | null;
    /** OUTBOX 행인데 재시도 폼을 내지 않을 때의 상태 한 줄(자동 재시도 중 등). */
    outboxNote: string | null;
  }[];
};

// ADMIN 전용(2026-09-18).
export async function loadAdminDlq(): Promise<AdminDlqView> {
  return runQuery({ command: "ADMIN_DLQ_VIEW" }, async () => {
    const supabase = await createClient();
    const { data: failures } = await supabase
      .from("dead_letters")
      .select("id, source, error_message, payload, created_at")
      .eq("resolved", false)
      .order("created_at", { ascending: false });

    const outboxIdOf = (failure: { source: string; payload: unknown }) => {
      const id = (failure.payload as Record<string, unknown> | null)?.outbox_message_id;
      return failure.source === "OUTBOX" && typeof id === "string" ? id : null;
    };

    // 재시도 폼은 죽은 메시지에만 낸다 — 해당 아웃박스 메시지 상태를 한 번에 읽는다(관리자 조회 정책).
    const outboxIds = [...new Set((failures ?? []).map(outboxIdOf).filter((id): id is string => id !== null))];
    const messageById = new Map<string, OutboxMessageState>();
    if (outboxIds.length > 0) {
      const { data: messages } = await supabase
        .from("outbox_messages")
        .select("id, attempts, dead_at, processed_at")
        .in("id", outboxIds);
      for (const m of messages ?? []) messageById.set(m.id, m);
    }

    return {
      failures: (failures ?? []).map((failure) => {
        const messageId = outboxIdOf(failure);
        const retry = outboxRetryDisplay(messageId, messageId ? (messageById.get(messageId) ?? null) : null);
        return {
          id: failure.id,
          source: failure.source,
          createdText: new Date(failure.created_at).toLocaleString("ko-KR"),
          errorMessage: failure.error_message,
          payloadJson: JSON.stringify(failure.payload, null, 2),
          outboxMessageId: retry.retryableMessageId,
          outboxNote: retry.note,
        };
      }),
    };
  });
}
