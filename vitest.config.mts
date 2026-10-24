import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "node:path";

// .env.local을 읽어야 통합 테스트(lib/outbox/*.integration.test.ts)가 로컬 Supabase에 접속할 수
// 있다. Next.js dev 서버는 이걸 자동으로 해주지만 vitest는 별도 프로세스라 직접 로드해야 한다.
export default defineConfig(({ mode }) => {
  process.env = { ...process.env, ...loadEnv(mode, process.cwd(), "") };

  return {
    resolve: {
      alias: {
        "@": path.resolve(process.cwd(), "."),
      },
    },
    test: {
      environment: "node",
      // e2e/*.spec.ts는 Playwright 몫이다(playwright.config.ts) — vitest 기본 include 패턴이
      // `.spec.ts`도 줍는 바람에 같이 실행하려 들어서 명시적으로 제외해야 한다.
      exclude: ["**/node_modules/**", "**/.next/**", "e2e/**"],
      // 기본 5000ms — *.guard.test.ts류(lib/audit/audit.guard.test.ts, lib/supabase/
      // identity.guard.test.ts 등)는 저장소 전체를 파일시스템으로 훑는데, Windows에서 콜드
      // 캐시 상태로 단독 실행하면 5초를 넘겨 "느린 것 = 실패"로 잘못 판정됐다(코드 결함이
      // 아니다 — 전체 스위트로 실행하면 4초대). 여유를 20초로 둔다(사용자
      // "컴파일속도가 느려서 대기하다가 실패처리 자주하고 있다. 여유를 가질 것").
      testTimeout: 20_000,
      // 파일을 하나씩 차례로 실행한다(2026-10-01). 통합 테스트들이 같은 로컬 DB의 아웃박스 대기열(outbox_messages)을
      // 공유하는데, 드레인(runOutboxBatch)은 대기열의 아무 메시지나 집어 처리한다 — 병렬로 돌면 다른 파일의 드레인이
      // 이 파일의 메시지를 가져가 자기 가짜 PG로 처리해 버리는 것으로 추정한다(직접 관찰은 못 함, 직렬로 하면 사라짐 — docs/adr/0003). 로컬 DB가 깨끗하고 대사가 빨라진 뒤 병렬 실행이
      // 겹쳐 offering-cancel 폐강 시나리오가 전체 실행에서만 4/4 실패(단독·직렬은 통과). 전체 약 17초 → 약 47초.
      fileParallelism: false,
    },
  };
});
