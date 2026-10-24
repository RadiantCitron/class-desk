import { defineConfig, devices } from "@playwright/test";
import { loadEnv } from "vite";

// Next.js dev 서버(webServer로 띄우는 자식 프로세스)는 .env.local을 자동으로 읽지만, Playwright
// 테스트 러너 자신의 프로세스(e2e/helpers.ts가 service_role로 DB에 접속할 때 씀)는 별도라
// 직접 로드해야 한다(vitest.config.mts와 동일한 이유).
// 가짜 PG URL·키는 .env.test에만 있다 — Next webServer에도 같은 값을 넘겨 런치 SDK가
// fake-pg를 가리키게 한다(.env.local에 실키/빈 값이 있어도 e2e는 가짜로 고정).
const testEnv = loadEnv("test", process.cwd(), "");
Object.assign(process.env, testEnv);

const webServerEnv: Record<string, string> = {};
for (const [k, v] of Object.entries({ ...process.env, ...testEnv })) {
  if (v !== undefined) webServerEnv[k] = v;
}

// E2E 테스트 — 실제 Chromium 브라우저 환경에서 사용자 인터랙션을 직접 검증한다.
// 사전 준비는 vitest 통합테스트와 동일: `npm run db:start` 후 실행해야 한다(로컬 Supabase 필요).
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // 전부 같은 로컬 DB를 공유하므로 순차 실행한다.
  workers: 1, // 파일 간에도 병렬로 안 돌게 강제(DB 상태 격리 및 최초 컴파일 경쟁 방지).
  retries: 0,
  // Next.js Turbopack 최초 온디맨드 컴파일 시간을 고려하여 타임아웃을 넉넉하게 설정한다.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    // next.config.ts가 Discord OAuth PKCE 연동 등을 위해 호스트를 127.0.0.1로 통일하므로
    // baseURL도 127.0.0.1:3000으로 고정하여 URL 단언 일관성을 보장한다.
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run dev",
      url: "http://127.0.0.1:3000",
      // e2e는 .env.test의 가짜 PG를 Next에 주입해야 하므로, 수동으로 띄운 .env.local 서버를
      // 재사용하지 않는다(재사용하면 NEXT_PUBLIC_TOSS_SDK_URL이 fake-pg가 아닐 수 있음).
      reuseExistingServer: false,
      timeout: 180_000,
      env: webServerEnv,
    },
    {
      command: "npm run fake-pg -- --port 4010",
      url: "http://127.0.0.1:4010/toss/v2/standard",
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
