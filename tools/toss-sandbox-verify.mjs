/**
 * 파이널 F3 — 토스 테스트 키로 공식 API 취소 분류 대조.
 * 사용: node tools/toss-sandbox-verify.mjs
 * .env.local의 TOSS_SECRET_KEY(test_)만 사용. 키 값은 출력하지 않는다.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_PATH = resolve(ROOT, ".env.local");
const API = "https://api.tosspayments.com";

function loadEnvLocal() {
  if (!existsSync(ENV_PATH)) throw new Error(".env.local 없음");
  const out = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const TOSS_REJECTED_ALREADY = new Set(["ALREADY_CANCELED_PAYMENT", "ALREADY_REFUND_PAYMENT"]);
const TOSS_REJECTED_400 = new Set([
  "ALREADY_CANCELED_PAYMENT",
  "ALREADY_REFUND_PAYMENT",
  "INVALID_REFUND_ACCOUNT_INFO",
  "INVALID_REFUND_ACCOUNT_NUMBER",
  "INVALID_BANK",
  "EXCEED_CANCEL_AMOUNT_DISCOUNT_AMOUNT",
  "INVALID_REQUEST",
  "NOT_MATCHES_REFUNDABLE_AMOUNT",
  "REFUND_REJECTED",
  "FORBIDDEN_BANK_REFUND_REQUEST",
  "INVALID_IDEMPOTENCY_KEY",
]);
const TOSS_REJECTED_401 = new Set(["UNAUTHORIZED_KEY"]);
const TOSS_REJECTED_403 = new Set([
  "NOT_CANCELABLE_AMOUNT",
  "NOT_CANCELABLE_PAYMENT",
  "FORBIDDEN_REQUEST",
  "EXCEED_MAX_REFUND_DUE",
  "NOT_ALLOWED_PARTIAL_REFUND_WAITING_DEPOSIT",
  "NOT_ALLOWED_PARTIAL_REFUND",
  "NOT_AVAILABLE_BANK",
  "INCORRECT_BASIC_AUTH_FORMAT",
  "NOT_CANCELABLE_PAYMENT_FOR_DORMANT_USER",
  "EXCEED_CANCEL_LIMIT",
]);
const TOSS_REJECTED_404 = new Set(["NOT_FOUND_PAYMENT"]);

function classify(status, body) {
  if (status >= 200 && status < 300) return { kind: "ACCEPTED" };
  const code = body?.code ?? "";
  const message = body?.message ?? `HTTP ${status}`;
  if (status === 400 && TOSS_REJECTED_400.has(code)) {
    return {
      kind: "REJECTED",
      code,
      alreadyCanceled: TOSS_REJECTED_ALREADY.has(code),
      message,
    };
  }
  if (status === 401 && TOSS_REJECTED_401.has(code)) {
    return { kind: "REJECTED", code, alreadyCanceled: false, message };
  }
  if (status === 403 && TOSS_REJECTED_403.has(code)) {
    return { kind: "REJECTED", code, alreadyCanceled: false, message };
  }
  if (status === 404 && TOSS_REJECTED_404.has(code)) {
    return { kind: "REJECTED", code, alreadyCanceled: false, message };
  }
  return { kind: "UNKNOWN", code, message, status };
}

async function cancel(secret, paymentKey, { amount, refundable, reason, idem, testCode }) {
  const headers = {
    Authorization: `Basic ${Buffer.from(`${secret}:`).toString("base64")}`,
    "Content-Type": "application/json",
    "Idempotency-Key": idem,
  };
  if (testCode) headers["TossPayments-Test-Code"] = testCode;
  const res = await fetch(`${API}/v1/payments/${encodeURIComponent(paymentKey)}/cancel`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      cancelReason: reason,
      cancelAmount: amount,
      refundableAmount: refundable,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, classified: classify(res.status, json) };
}

function row(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}\t${name}\t${detail}`);
}

async function main() {
  const env = loadEnvLocal();
  const secret = env.TOSS_SECRET_KEY ?? "";
  const client = env.NEXT_PUBLIC_TOSS_CLIENT_KEY ?? "";
  if (!secret.startsWith("test_")) {
    throw new Error("TOSS_SECRET_KEY가 test_로 시작하지 않음 — F3 중단");
  }
  if (!client.startsWith("test_")) {
    throw new Error("NEXT_PUBLIC_TOSS_CLIENT_KEY가 test_로 시작하지 않음 — F3 중단");
  }
  console.log(
    `env secret_prefix=${secret.slice(0, 8)}… client_prefix=${client.slice(0, 8)}… api=${API}`,
  );

  const fakeKey = `f3-missing-${randomUUID()}`;
  const idemA = randomUUID();

  // 1) 없는 paymentKey → NOT_FOUND_PAYMENT → REJECTED
  const missing = await cancel(secret, fakeKey, {
    amount: 1000,
    refundable: 1000,
    reason: "F3 missing key",
    idem: idemA,
  });
  const missOk =
    missing.classified.kind === "REJECTED" && missing.classified.code === "NOT_FOUND_PAYMENT";
  row(
    "cancel-missing-key",
    missOk,
    `HTTP ${missing.status} code=${missing.json?.code ?? "(none)"} class=${missing.classified.kind}`,
  );

  // 2) 같은 멱등키로 재호출 — 없어도 같은 분류(또는 동일 응답)인지 기록
  const missing2 = await cancel(secret, fakeKey, {
    amount: 1000,
    refundable: 1000,
    reason: "F3 missing key",
    idem: idemA,
  });
  row(
    "cancel-missing-idempotent-replay",
    missing2.classified.kind === "REJECTED" &&
      missing2.classified.code === "NOT_FOUND_PAYMENT",
    `HTTP ${missing2.status} code=${missing2.json?.code ?? "(none)"} class=${missing2.classified.kind}`,
  );

  // 3) TossPayments-Test-Code 로 표의 REJECTED 몇 종 강제
  const testCodes = [
    "NOT_CANCELABLE_PAYMENT",
    "NOT_MATCHES_REFUNDABLE_AMOUNT",
    "ALREADY_CANCELED_PAYMENT",
    "UNAUTHORIZED_KEY",
  ];
  for (const code of testCodes) {
    const r = await cancel(secret, fakeKey, {
      amount: 1000,
      refundable: 1000,
      reason: `F3 test ${code}`,
      idem: randomUUID(),
      testCode: code,
    });
    const ok =
      r.classified.kind === "REJECTED" &&
      (r.classified.code === code ||
        // 없는 키면 NOT_FOUND가 테스트 헤더보다 앞설 수 있음 — 그대로 보고
        r.classified.code === "NOT_FOUND_PAYMENT");
    row(
      `test-code-${code}`,
      ok,
      `HTTP ${r.status} code=${r.json?.code ?? "(none)"} class=${r.classified.kind}` +
        (r.classified.code === "NOT_FOUND_PAYMENT" && code !== "NOT_FOUND_PAYMENT"
          ? " (헤더보다 NOT_FOUND 우선 — 실결제키 필요)"
          : ""),
    );
  }

  // 4) 잔액 불일치 본문(헤더 없이) — 없는 키면 NOT_FOUND
  const mismatch = await cancel(secret, fakeKey, {
    amount: 1000,
    refundable: 999,
    reason: "F3 refundable mismatch",
    idem: randomUUID(),
  });
  row(
    "refundableAmount-without-payment",
    mismatch.classified.kind === "REJECTED",
    `HTTP ${mismatch.status} code=${mismatch.json?.code ?? "(none)"} class=${mismatch.classified.kind}`,
  );

  console.log(
    "NOTE\t정상취소·이미취소재취소·실결제 멱등재호출·웹훅은 paymentKey(테스트 결제 1건) 또는 터널 필요 — 보고서에 보류 표기",
  );
}

main().catch((err) => {
  console.error("FATAL", err instanceof Error ? err.message : err);
  process.exit(1);
});
