import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/**
 * vitest에서 가짜 PG를 임의 포트로 띄운다.
 * beforeAll → startFakePg(), afterAll → stopFakePg().
 */
let proc: ChildProcess | null = null;
let listeningPort: number | null = null;

export function getFakePgPort(): number {
  if (listeningPort == null) throw new Error("fake-pg가 기동되지 않았습니다.");
  return listeningPort;
}

export function getFakePgOrigin(): string {
  return `http://127.0.0.1:${getFakePgPort()}`;
}

/** 어댑터 테스트용 env 오버라이드(호출부가 process.env에 적용). */
export function fakePgEnvOverrides(): Record<string, string> {
  const origin = getFakePgOrigin();
  return {
    TOSS_SECRET_KEY: "test_sk_fake0000000000000000",
    NEXT_PUBLIC_TOSS_CLIENT_KEY: "test_ck_fake0000000000000000",
    TOSS_API_BASE_URL: `${origin}/toss`,
    NEXT_PUBLIC_TOSS_SDK_URL: `${origin}/toss/v2/standard`,
  };
}

export async function setTossCancelBehavior(
  paymentKey: string,
  mode:
    | "reject_403"
    | "provider_error_400"
    | "server_500"
    | "timeout_before_apply"
    | "timeout_after_apply"
    | "off",
): Promise<void> {
  const res = await fetch(`${getFakePgOrigin()}/__control/toss/cancel-behavior`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentKey, mode }),
  });
  if (!res.ok) throw new Error(`setTossCancelBehavior 실패: ${res.status}`);
}

export function startFakePg(): Promise<number> {
  if (proc) return Promise.resolve(getFakePgPort());

  return new Promise((resolve, reject) => {
    const script = join(process.cwd(), "tools/fake-pg/server.mjs");
    const child = spawn(process.execPath, [script, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc = child;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("fake-pg 기동 타임아웃(LISTENING 없음)"));
    }, 15_000);

    const onData = (buf: Buffer) => {
      const text = buf.toString("utf8");
      const m = text.match(/LISTENING:(\d+)/);
      if (!m) return;
      clearTimeout(timer);
      listeningPort = Number(m[1]);
      child.stdout!.off("data", onData);
      resolve(listeningPort);
    };

    child.stdout!.on("data", onData);
    child.stderr!.on("data", (buf) => {
      console.error("[fake-pg]", buf.toString("utf8"));
    });
    child.on("exit", (code) => {
      if (listeningPort == null) {
        clearTimeout(timer);
        reject(new Error(`fake-pg가 LISTENING 전에 종료됨(code=${code})`));
      }
      proc = null;
      listeningPort = null;
    });
  });
}

export function stopFakePg(): void {
  cleanup();
}

function cleanup() {
  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
  }
  proc = null;
  listeningPort = null;
}
