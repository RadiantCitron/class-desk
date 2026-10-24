// 가짜 PG 전용 개발 서버: 가짜 PG(4010) + next dev를 .env.test 값으로 함께 띄운다.
// `npm run dev`는 .env.local의 실제 토스 테스트 키를 쓰지만, 이 스크립트는 프로세스 환경변수로
// .env.test 값을 강제한다(Next는 이미 설정된 환경변수를 .env.local로 덮어쓰지 않는다).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function parseEnvFile(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function fail(message) {
  console.error(`[dev:fake] ${message}`);
  process.exit(1);
}

const testEnv = parseEnvFile(join(root, ".env.test"));

// 안전 검사 — 실제 PG를 부를 수 있는 값이면 띄우지 않는다.
const isLocalHost = (url) => {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
};
for (const key of ["TOSS_API_BASE_URL", "NEXT_PUBLIC_TOSS_SDK_URL"]) {
  if (!isLocalHost(testEnv[key] ?? "")) {
    fail(`.env.test의 ${key}가 127.0.0.1/localhost가 아닙니다(${testEnv[key] ?? "없음"}). 중단합니다.`);
  }
}
if (!(testEnv.TOSS_SECRET_KEY ?? "").startsWith("test_sk_fake")) {
  fail(".env.test의 TOSS_SECRET_KEY가 test_sk_fake로 시작하지 않습니다. 중단합니다.");
}

console.log(
  "가짜 PG 모드 — 결제는 모두 127.0.0.1:4010(가짜)으로 갑니다. 실제 토스를 부르지 않습니다.",
);

const appBase = testEnv.APP_BASE_URL || "http://127.0.0.1:3000";
const children = [];
let shuttingDown = false;

function stopAll(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (c.exitCode === null) c.kill();
  }
  process.exitCode = code;
}

function prefixLines(stream, prefix, out) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const l of lines) out.write(`${prefix}${l}\n`);
  });
}

const startedAt = Date.now();
const fakePg = spawn(process.execPath, ["tools/fake-pg/server.mjs", "--port", "4010"], {
  cwd: root,
  env: { ...process.env, FAKE_PG_TOSS_WEBHOOK_URL: `${appBase}/api/webhooks/payment/toss` },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(fakePg);
prefixLines(fakePg.stdout, "[fake-pg] ", process.stdout);
prefixLines(fakePg.stderr, "[fake-pg] ", process.stderr);
fakePg.on("exit", (code) => {
  if (!shuttingDown && Date.now() - startedAt < 3000) {
    console.error("[dev:fake] 4010 포트 사용 중 — 이전 fake-pg를 끄세요.");
  }
  stopAll(code ?? 1);
});

const next = spawn(process.execPath, [join("node_modules", "next", "dist", "bin", "next"), "dev"], {
  cwd: root,
  env: { ...process.env, ...testEnv },
  stdio: "inherit",
});
children.push(next);
next.on("exit", (code) => stopAll(code ?? 1));

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
