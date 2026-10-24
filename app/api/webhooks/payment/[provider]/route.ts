import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ingestWebhook,
  PaymentWebhookError,
  providerNameFromUrlSegment,
} from "@/lib/payment";
import { runOutboxBatch } from "@/lib/wiring/outbox";

// 웹훅 끝 드레인이 폐강 환불 메시지를 집을 수 있어 길어질 수 있음(Doc-2 §6, Code-B).
export const maxDuration = 60;

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

// 결제 웹훅 수신부. PG별 경로(`/api/webhooks/payment/{toss}`(PG별 세그먼트)). 서명 검증과 파싱은
// 파사드(ingestWebhook) 안의 PG 어댑터가 한다. 이 파일은 PG 구현체를 import하지 않는다.
// 파싱 실패든 처리 실패든 원칙적으로 dead_letters(DLQ)에 남기고 ack를 반환한다(재시도 폭주
// 방지). 단 **DLQ 적재 자체가 실패한 경우**(원장도 DLQ도 못 쓴 경우)엔 이 요청의 유일한
// 증거가 사라지므로 5xx로 PG의 재전송을 유도한다(2026-09-26 -1).
// 재시도 가능 오류는 DLQ에 남겨도 5xx. 순수 인증 실패는 DLQ 없이 401.
async function logFailure(
  admin: ReturnType<typeof createAdminClient>,
  source: string,
  payload: unknown,
  message: string,
): Promise<boolean> {
  try {
    const { error } = await admin.from("dead_letters").insert({
      source,
      payload: payload as object,
      error_message: message,
    });
    if (error) {
      console.error("웹훅 실패 기록(DLQ) 적재 실패:", error.message, "| 원래 오류:", message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("웹훅 실패 기록(DLQ) 적재 중 예외:", err, "| 원래 오류:", message);
    return false;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: segment } = await params;
  const providerName = providerNameFromUrlSegment(segment);
  if (!providerName) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  // F-7: 본문 상한 — 초과 시 DLQ 없이 413
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  const admin = createAdminClient();

  let outcome;
  try {
    outcome = await ingestWebhook(providerName, rawBody, request.headers);
  } catch (err) {
    if (err instanceof PaymentWebhookError && err.authFailure) {
      console.warn("웹훅 인증 실패(DLQ 미적재):", err.message);
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    const logged =
      err instanceof PaymentWebhookError
        ? await logFailure(admin, err.source, err.payload, err.message)
        : await logFailure(
            admin,
            "INTERNAL",
            { rawBody: rawBody.slice(0, 4096) },
            `결제 이벤트 기록 실패: ${err instanceof Error ? err.message : String(err)}`,
          );

    const retryable = err instanceof PaymentWebhookError && err.retryable;
    // DLQ 실패 또는 재시도 가능 오류 → 5xx. 그 외 적재 성공은 200.
    if (!logged || retryable) {
      return NextResponse.json({ ok: false }, { status: 500 });
    }
    return NextResponse.json({ ok: false }, { status: 200 });
  }

  // 건별 confirm 실패도 throw 경로와 같다: DLQ까지 실패하면 증거가 사라지므로 5xx
  // (F-1, 2026-09-29 점검리포트). 드레인·ack보다 먼저 판정한다.
  let allLogged = true;
  for (const failure of outcome.failures) {
    const logged = await logFailure(admin, providerName, failure.raw, failure.message);
    if (!logged) allLogged = false;
  }
  if (!allLogged) {
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  // 무거운 후속작업은 웹훅 응답 전에 한 번만 시도한다. 실패해도 원장 기록은 이미 끝났다.
  try {
    await runOutboxBatch();
  } catch (err) {
    console.error("웹훅 직후 아웃박스 드레인 실패(다음 드레인에서 재시도):", err);
  }

  const ack = outcome.ack;
  return new NextResponse(ack.body, {
    status: ack.status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
