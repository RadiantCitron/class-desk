import { NextResponse } from "next/server";
import { runOutboxBatch } from "@/lib/wiring/outbox";
import { endExpiredOfferings } from "@/lib/orders/auto-end";

// 엔드포인트만 만들어둔다. 상주 프로세스 없이 ①웹훅 응답 직전 ②관리자 수동 실행 버튼에서도
// 드레인이 이미 시도되므로, 이 경로는 Vercel Cron(하루 1번)으로 배선된다.
//
// 전수조사에서 이 경로가 로그인 없이 누구나 호출 가능했다는 것을 발견했다
// (proxy.ts matcher 밖, 가드 없음). runOutboxBatch()는 권한 부여·회수를 실제로 실행하는 쓰기
// 작업이라, 크론 시크릿으로 막는다. CRON_SECRET이 설정돼 있지 않으면(로컬 기본 상태) 항상
// 401을 돌려준다 — "설정 안 함"이 "누구나 호출 가능"으로 새지 않도록 기본값을 닫힌 쪽으로 둔다.
// Vercel Cron은 GET으로 호출한다(POST는 수동/다른 스케줄러용으로 남겨 둔다 — 둘 다 같은 인증·
// 같은 동작).
async function handleCronDrain(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");

  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 종강일이 지난 개설강의를 먼저 자동 종료한다 — 종료가 적재한 이용권 회수 사실을 바로 아래 드레인이 같은 호출에서 처리한다.
  // 자동 종료의 실패는 던지지 않고 DLQ에 남기므로 드레인을 막지 않는다.
  const autoEnd = await endExpiredOfferings();
  const result = await runOutboxBatch();
  return NextResponse.json({ ...result, autoEnd });
}

export async function GET(request: Request) {
  return handleCronDrain(request);
}

export async function POST(request: Request) {
  return handleCronDrain(request);
}
