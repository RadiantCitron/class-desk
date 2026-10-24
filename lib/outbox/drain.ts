import { createAdminClient } from "@/lib/supabase/admin";
import { checkSystemIntegrity } from "@/lib/integrity/checks";

// 아웃박스 러너(CS 모듈의 오케스트레이터) — 업무를 모른다.
// 하는 일: 미처리 메시지 읽기 → 연동표(routes)가 가리키는 핸들러에 배달 → 성공이면 처리 완료,
// 실패면 재시도 예약·최초 실패 시 DLQ. "어떤 토픽에 누가 반응하나"는 이 파일이 아니라
// lib/wiring/outbox.ts(연동표)에 있다 — 진입점은 그 파일의 runOutboxBatch()를 부른다.
export type OutboxHandler = (payload: Record<string, unknown>) => Promise<void>;
export type OutboxRoutes = Record<string, OutboxHandler>;

// 한 번 불릴 때 "처리하면서 새로 쌓인 메시지"(예: 결제 사실 → 주문 핸들러가 남긴 주문 사실)까지
// 이어서 처리하는 최대 바퀴 수. 상한이 없으면 핸들러 버그로 메시지가 계속 생길 때 요청이 끝나지
// 않는다.
const MAX_ROUNDS = 5;

// 메시지를 집어 온 러너만 처리하도록 잡아 두는 시간(초). 이 안에 처리를 끝내면 processed_at이
// 찍히고, 러너가 도중에 죽으면 이 시간이 지난 뒤 다른 러너가 다시 집는다(핸들러는 멱등).
const LEASE_SECONDS = 300;
// 이 횟수를 넘겨 실패하면 자동 재시도를 멈추고 dead_at을 찍는다(AP6). 백오프 상한(60분)으로
// 계산하면 10회째는 이미 여러 시간 전에 실패가 시작된 뒤다 — 그 정도면 자동 회복을 기대하지
// 않고 사람이 봐야 한다고 판단했다.
const MAX_ATTEMPTS = 10;

// 상주 소비자 데몬 대신 ① 결제 웹훅 응답 직후 ② 관리자 수동 드레인 버튼 ③ 일일 배치 크론(/api/cron/outbox)
// 세 경로에서 이 함수를 호출해 미처리 아웃박스 메시지를 드레인한다.
//
// 여러 러너가 동시에 실행될 수 있으므로 `claim_outbox_messages()` RPC를 통해
// `FOR UPDATE SKIP LOCKED` 기반 임대(Lease)를 획득하여 동일 메시지 중복 처리 경쟁을 방지한다.
export async function drainOutbox(routes: OutboxRoutes, limit = 10) {
  const admin = createAdminClient();
  let processed = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { data: messages, error: claimError } = await admin.rpc("claim_outbox_messages", {
      p_limit: limit,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (claimError) {
      throw new Error(`아웃박스 메시지 선점 실패: ${claimError.message}`);
    }

    const claimed = (messages ?? []) as {
      id: string;
      topic: string;
      payload: unknown;
      attempts: number;
    }[];
    if (claimed.length === 0) {
      break;
    }

    for (const message of claimed) {
      try {
        const handler = routes[message.topic];
        if (!handler) {
          throw new Error(`연동표(lib/wiring/outbox.ts)에 없는 토픽: ${message.topic}`);
        }
        await handler(message.payload as Record<string, unknown>);

        const { error: doneError } = await admin
          .from("outbox_messages")
          .update({ processed_at: new Date().toISOString() })
          .eq("id", message.id);
        if (doneError) {
          // 처리는 끝났는데 완료 표시만 실패 — 임대가 끝나면 다시 처리된다(핸들러는 멱등).
          console.error(`아웃박스 완료 표시 실패(id=${message.id}):`, doneError.message);
        }
        processed += 1;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const attempts = message.attempts + 1;
        const backoffMinutes = Math.min(60, 2 ** attempts);

        // 실패는 DLQ(dead_letters)에 적재하여 비동기 처리 실패를 관리자가 파악할 수 있도록 한다.
        // 재시도마다 중복 적재되지 않도록 최초 실패(attempts가 0에서 1이 되는 순간)에만 1건 기록한다.
        if (message.attempts === 0) {
          const { error: dlqError } = await admin.from("dead_letters").insert({
            source: "OUTBOX",
            payload: { outbox_message_id: message.id, ...(message.payload as object) },
            error_message: `아웃박스 처리 실패(topic=${message.topic}): ${errorMessage}`,
          });
          if (dlqError) {
            console.error(`아웃박스 실패 DLQ 적재 실패(id=${message.id}):`, dlqError.message);
          }
        }

        const giveUp = attempts >= MAX_ATTEMPTS;
        const { error: retryError } = await admin
          .from("outbox_messages")
          .update({
            attempts,
            last_error: errorMessage,
            ...(giveUp
              ? { dead_at: new Date().toISOString() }
              : { next_attempt_at: new Date(Date.now() + backoffMinutes * 60_000).toISOString() }),
          })
          .eq("id", message.id);
        if (retryError) {
          // 재시도 예약 실패 — 임대 시간이 지나면 어차피 다시 집힌다(giveUp이면 dead_at 갱신
          // 실패지만, 다음 배치가 다시 시도하다 결국 giveUp에 도달한다).
          console.error(`아웃박스 재시도 예약 실패(id=${message.id}):`, retryError.message);
        }
        if (giveUp) {
          // 최초 실패 DLQ(위)와 별개로, "자동 재시도를 그만뒀다"는 것 자체를 다시 알린다 —
          // 관리자가 처음 DLQ만 보고 "재시도되겠지" 하고 넘어간 뒤 방치되는 것을 막는다.
          const { error: deadDlqError } = await admin.from("dead_letters").insert({
            source: "OUTBOX",
            payload: { outbox_message_id: message.id, ...(message.payload as object) },
            error_message: `아웃박스 처리 최대 재시도(${MAX_ATTEMPTS}회) 초과 — 자동 재시도를 멈췄습니다(topic=${message.topic}). "재시도" 처리 후 원인을 해결하세요. 최근 오류: ${errorMessage}`,
          });
          if (deadDlqError) {
            console.error(`아웃박스 종료 DLQ 적재 실패(id=${message.id}):`, deadDlqError.message);
          }
        }
      }
    }
  }

  // 대사(두 장부 맞춰 보기)는 요청 경로가 아니라 배치 끝에서 한다.
  // 읽기만 하고 고치지 않는다 — 이상하면 DLQ에 경고만 남긴다. 스스로 실패를 삼킨다.
  await checkSystemIntegrity();

  return { processed };
}
