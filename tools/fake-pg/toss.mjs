import {
  tossPayments,
  newTossPaymentKey,
  newTossTxKey,
  TOSS_SECRET,
} from "./state.mjs";

const DEFAULT_TOSS_WEBHOOK_URL = process.env.FAKE_PG_TOSS_WEBHOOK_URL || null;

function basicAuthOk(req) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  // 토스: secretKey + ":" (비밀번호 빈 문자열)
  return decoded === `${TOSS_SECRET}:`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve(Object.fromEntries(new URLSearchParams(raw)));
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

async function postWebhook(url, payload) {
  if (!url) return { ok: false, reason: "no webhook url" };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    return { ok: r.ok, status: r.status };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function paymentPublicView(p) {
  return {
    paymentKey: p.paymentKey,
    orderId: p.orderId,
    status: p.status,
    totalAmount: p.amount,
    method: "CARD",
    approvedAt: p.approvedAt ?? null,
    lastTransactionKey: p.lastTransactionKey ?? null,
    cancels: p.cancels ?? [],
  };
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} pathname
 * @param {URL} url
 */
export async function handleToss(req, res, pathname, url) {
  if (pathname === "/toss/v2/standard" && req.method === "GET") {
    const origin = `http://${req.headers.host ?? "127.0.0.1:4010"}`;
    const script = `
var FAKE_PG_ORIGIN = ${JSON.stringify(origin)};
window.TossPayments = function TossPayments(clientKey) {
  // 토스 신형 결제창형(widgets) 계약을 흉내 낸다. 구버전 payment()·최상위 requestPayment는 일부러 없다 —
  // 코드가 구버전 호출로 돌아가면 e2e가 실패하도록. 진짜 SDK와 같은 순서·검증 오류만 재현한다.
  function InvalidParameters(msg) { var e = new Error(msg); e.code = "INVALID_PARAMETERS"; return e; }
  function goCheckout(params, amountValue) {
    var q = new URLSearchParams({
      orderId: params.orderId || "",
      amount: String(amountValue),
      orderName: params.orderName || "",
      successUrl: params.successUrl || "",
      failUrl: params.failUrl || "",
      clientKey: clientKey || ""
    });
    // 앱 오리진(3000)이 아니라 가짜 PG 오리진으로 보낸다 — 상대경로면 /pg/toss/launch에서
    // 앱의 /toss/checkout로 가 404가 난다.
    location.href = FAKE_PG_ORIGIN + "/toss/checkout?" + q.toString();
  }
  return {
    widgets: function(opts) {
      if (!opts || !opts.customerKey) throw InvalidParameters("customerKey가 누락되었습니다.");
      var amountState = null;
      var rendered = null; // { orderName, handler }
      return {
        setAmount: async function(a) {
          if (!a || !Number.isInteger(a.value) || !a.currency) throw InvalidParameters("amount가 올바르지 않습니다.");
          amountState = a;
        },
        renderPaymentWindow: async function(opts2) {
          if (rendered) throw new Error("이미 렌더링된 결제창이 있습니다.");
          if (!amountState) throw new Error("setAmount로 결제 금액을 먼저 설정해야 합니다.");
          rendered = { orderName: opts2 && opts2.orderName, handler: null, cancelHandler: null, overlay: null };
          // 실제 토스처럼 호출한 페이지 위에 결제창(오버레이)을 그린다 — 닫기("닫기(가짜 토스)")는 창을 지우고 cancel 이벤트를 준다(실제 SDK와 같음).
          var overlay = document.createElement("div");
          overlay.id = "fake-toss-window";
          overlay.setAttribute("role", "dialog");
          overlay.setAttribute("aria-label", "가짜 토스 결제창");
          overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999";
          overlay.innerHTML = '<div style="background:#fff;padding:24px;border-radius:8px;min-width:280px">' +
            '<p>가짜 토스 결제창 (' + String(amountState.value) + '원)</p>' +
            '<button type="button" id="fake-toss-pay">카드로 결제 진행(가짜 토스)</button> ' +
            '<button type="button" id="fake-toss-close">닫기(가짜 토스)</button></div>';
          document.body.appendChild(overlay);
          rendered.overlay = overlay;
          overlay.querySelector("#fake-toss-close").addEventListener("click", function() {
            overlay.remove();
            if (rendered && rendered.cancelHandler) rendered.cancelHandler();
          });
          overlay.querySelector("#fake-toss-pay").addEventListener("click", function() {
            // 실제 토스는 구매자가 토스 UI의 '결제하기'를 누르면 paymentRequest 이벤트가 발생한다.
            if (rendered && rendered.handler) rendered.handler({});
          });
          return {
            on: function(event, fn) {
              if (event !== "paymentRequest" && event !== "cancel") throw InvalidParameters("지원하지 않는 이벤트입니다.");
              if (typeof fn !== "function") throw InvalidParameters("콜백은 함수여야 합니다.");
              if (event === "cancel") rendered.cancelHandler = fn;
              else rendered.handler = fn;
            },
            destroy: async function() {
              if (rendered && rendered.overlay) rendered.overlay.remove();
              rendered = null;
            }
          };
        },
        requestPayment: async function(params) {
          if (!rendered) throw new Error("결제창을 먼저 렌더링해야 합니다.");
          if (!amountState) throw new Error("setAmount로 결제 금액을 먼저 설정해야 합니다.");
          if (!params.successUrl || !params.failUrl) throw InvalidParameters("successUrl·failUrl이 모두 필요합니다.");
          if (rendered.orderName != null && rendered.orderName !== params.orderName) {
            throw InvalidParameters("renderPaymentWindow에 전달한 orderName과 다릅니다.");
          }
          goCheckout(params, amountState.value);
        }
      };
    }
  };
};
`;
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(script);
    return true;
  }

  if (pathname === "/toss/checkout" && req.method === "GET") {
    const orderId = url.searchParams.get("orderId") ?? "";
    const amount = url.searchParams.get("amount") ?? "";
    const successUrl = url.searchParams.get("successUrl") ?? "";
    const failUrl = url.searchParams.get("failUrl") ?? "";
    const webhookUrl = url.searchParams.get("webhookUrl") ?? "";
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>fake toss checkout</title></head>
<body>
  <h1>가짜 토스 결제창</h1>
  <p>orderId=${escapeHtml(orderId)} amount=${escapeHtml(amount)}</p>
  <form method="POST" action="/toss/checkout/confirm">
    <input type="hidden" name="orderId" value="${escapeAttr(orderId)}" />
    <input type="hidden" name="amount" value="${escapeAttr(amount)}" />
    <input type="hidden" name="successUrl" value="${escapeAttr(successUrl)}" />
    <input type="hidden" name="failUrl" value="${escapeAttr(failUrl)}" />
    <input type="hidden" name="webhookUrl" value="${escapeAttr(webhookUrl)}" />
    <button type="submit">성공</button>
  </form>
  <form method="POST" action="/toss/checkout/fail">
    <input type="hidden" name="orderId" value="${escapeAttr(orderId)}" />
    <input type="hidden" name="failUrl" value="${escapeAttr(failUrl)}" />
    <input type="hidden" name="code" value="PAY_PROCESS_CANCELED" />
    <input type="hidden" name="message" value="사용자가 취소했습니다" />
    <button type="submit">실패/취소</button>
  </form>
  <form method="POST" action="/toss/checkout/fail">
    <input type="hidden" name="orderId" value="${escapeAttr(orderId)}" />
    <input type="hidden" name="failUrl" value="${escapeAttr(failUrl)}" />
    <input type="hidden" name="code" value="REJECT_CARD_COMPANY" />
    <input type="hidden" name="message" value="카드사 거절" />
    <button type="submit">카드사 거절</button>
  </form>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return true;
  }

  if (pathname === "/toss/checkout/confirm" && req.method === "POST") {
    const form = await readForm(req);
    const amount = Number(form.amount);
    const paymentKey = newTossPaymentKey();
    const lastTransactionKey = newTossTxKey();
    tossPayments.set(paymentKey, {
      paymentKey,
      orderId: form.orderId,
      amount,
      status: "READY",
      confirmed: false,
      webhookUrl: form.webhookUrl || DEFAULT_TOSS_WEBHOOK_URL,
      cancels: [],
      lastTransactionKey,
      approvedAt: null,
      // amount===2: confirm 성공 후 웹훅 전송 실패(재시도 시나리오)
      dropWebhook: amount === 2,
    });
    const dest = new URL(form.successUrl || "http://127.0.0.1:3000/");
    dest.searchParams.set("paymentKey", paymentKey);
    dest.searchParams.set("orderId", form.orderId);
    dest.searchParams.set("amount", String(amount));
    redirect(res, dest.toString());
    return true;
  }

  if (pathname === "/toss/checkout/fail" && req.method === "POST") {
    const form = await readForm(req);
    const dest = new URL(form.failUrl || "http://127.0.0.1:3000/");
    // 실토스 실패 복귀와 같이 orderId를 붙인다(원장 FK 매핑용).
    if (form.orderId) dest.searchParams.set("orderId", form.orderId);
    dest.searchParams.set("code", form.code || "FAIL");
    dest.searchParams.set("message", form.message || "실패");
    redirect(res, dest.toString());
    return true;
  }

  if (pathname === "/toss/v1/payments/confirm" && req.method === "POST") {
    if (!basicAuthOk(req)) {
      sendJson(res, 401, { code: "UNAUTHORIZED_KEY", message: "시크릿 키가 올바르지 않습니다." });
      return true;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { code: "INVALID_REQUEST", message: "JSON 파싱 실패" });
      return true;
    }
    const p = tossPayments.get(body.paymentKey);
    if (!p) {
      sendJson(res, 404, { code: "NOT_FOUND_PAYMENT_SESSION", message: "결제 세션 없음" });
      return true;
    }
    if (p.orderId !== body.orderId || p.amount !== Number(body.amount)) {
      sendJson(res, 400, { code: "REJECT_CARD_COMPANY", message: "orderId/amount 불일치" });
      return true;
    }
    // 매직 금액 1: 확정 거절(403 카드 한도 등 거절) — 원장에 결제 실패가 남아야 한다.
    if (p.amount === 1) {
      sendJson(res, 403, { code: "REJECT_CARD_PAYMENT", message: "매직 금액 1 — confirm 거절" });
      return true;
    }
    // 매직 금액 4·5: 결과 불명(500) — 4는 재조회가 READY(확정 못 함), 5는 재조회도 500. 원장에 쓰지 않아야 한다.
    if (p.amount === 4 || p.amount === 5) {
      sendJson(res, 500, { code: "FAILED_INTERNAL_SYSTEM_PROCESSING", message: "매직 금액 4·5 — confirm 결과 불명" });
      return true;
    }
    // 매직 금액 3: WAITING_FOR_DEPOSIT (F-3 회귀 — confirm 2xx지만 DONE 아님)
    if (p.amount === 3) {
      p.status = "WAITING_FOR_DEPOSIT";
      p.lastTransactionKey = p.lastTransactionKey || newTossTxKey();
      sendJson(res, 200, paymentPublicView(p));
      return true;
    }
    if (p.confirmed) {
      sendJson(res, 400, { code: "ALREADY_PROCESSED_PAYMENT", message: "이미 처리된 결제" });
      return true;
    }
    p.confirmed = true;
    p.status = "DONE";
    p.approvedAt = new Date().toISOString();
    p.lastTransactionKey = p.lastTransactionKey || newTossTxKey();
    sendJson(res, 200, paymentPublicView(p));
    return true;
  }

  const payMatch = pathname.match(/^\/toss\/v1\/payments\/([^/]+)$/);
  if (payMatch && req.method === "GET") {
    if (!basicAuthOk(req)) {
      sendJson(res, 401, { code: "UNAUTHORIZED_KEY", message: "시크릿 키가 올바르지 않습니다." });
      return true;
    }
    const p = tossPayments.get(decodeURIComponent(payMatch[1]));
    if (!p) {
      sendJson(res, 404, { code: "NOT_FOUND_PAYMENT", message: "결제 없음" });
      return true;
    }
    if (p.amount === 5) {
      sendJson(res, 500, { code: "FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING", message: "매직 금액 5 — 조회 실패" });
      return true;
    }
    sendJson(res, 200, paymentPublicView(p));
    return true;
  }

  const cancelMatch = pathname.match(/^\/toss\/v1\/payments\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    if (!basicAuthOk(req)) {
      sendJson(res, 401, { code: "UNAUTHORIZED_KEY", message: "시크릿 키가 올바르지 않습니다." });
      return true;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { code: "INVALID_REQUEST", message: "JSON 파싱 실패" });
      return true;
    }
    const paymentKey = decodeURIComponent(cancelMatch[1]);
    const p = tossPayments.get(paymentKey);
    if (!p) {
      sendJson(res, 404, { code: "NOT_FOUND_PAYMENT", message: "결제 없음" });
      return true;
    }

    const idemKey = req.headers["idempotency-key"];
    if (idemKey) {
      p.idempotency = p.idempotency ?? new Map();
      const cached = p.idempotency.get(idemKey);
      if (cached) {
        sendJson(res, cached.status, cached.body);
        return true;
      }
    }

    const behavior = p.cancelBehavior;
    if (behavior) {
      p.cancelBehavior = null; // 일회성
      if (behavior === "reject_403") {
        const err = { code: "NOT_CANCELABLE_PAYMENT", message: "취소할 수 없는 결제" };
        if (idemKey) {
          p.idempotency = p.idempotency ?? new Map();
          p.idempotency.set(idemKey, { status: 403, body: err });
        }
        sendJson(res, 403, err);
        return true;
      }
      if (behavior === "provider_error_400") {
        const err = { code: "PROVIDER_ERROR", message: "일시 오류" };
        if (idemKey) {
          p.idempotency = p.idempotency ?? new Map();
          p.idempotency.set(idemKey, { status: 400, body: err });
        }
        sendJson(res, 400, err);
        return true;
      }
      if (behavior === "server_500") {
        const err = { code: "FAILED_REFUND_PROCESS", message: "환불 처리 실패" };
        if (idemKey) {
          p.idempotency = p.idempotency ?? new Map();
          p.idempotency.set(idemKey, { status: 500, body: err });
        }
        sendJson(res, 500, err);
        return true;
      }
      if (behavior === "timeout_before_apply") {
        // 응답 없음 — 클라이언트 타임아웃. 취소 미적용.
        return true;
      }
      if (behavior === "timeout_after_apply") {
        // 취소 적용+웹훅 후 응답 안 줌
        const cancelAmount = Number(body.cancelAmount);
        const transactionKey = newTossTxKey();
        p.cancels = p.cancels ?? [];
        p.cancels.push({
          cancelAmount,
          cancelReason: body.cancelReason ?? "",
          transactionKey,
          canceledAt: new Date().toISOString(),
        });
        const canceledSum = p.cancels.reduce((s, c) => s + c.cancelAmount, 0);
        p.status = canceledSum >= p.amount ? "CANCELED" : "PARTIAL_CANCELED";
        p.lastTransactionKey = transactionKey;
        const webhookUrl = body.webhookUrl || p.webhookUrl;
        setImmediate(() => {
          if (p.dropWebhook) return;
          void postWebhook(webhookUrl, {
            eventType: "PAYMENT_STATUS_CHANGED",
            data: paymentPublicView(p),
          });
        });
        return true;
      }
    }

    const cancelAmount = Number(body.cancelAmount);
    if (!Number.isFinite(cancelAmount) || cancelAmount <= 0) {
      const err = { code: "INVALID_REQUEST", message: "cancelAmount 없음/≤0" };
      sendJson(res, 400, err);
      return true;
    }
    p.cancels = p.cancels ?? [];
    const already = p.cancels.reduce((s, c) => s + c.cancelAmount, 0);
    const balance = p.amount - already;
    if (balance <= 0) {
      const err = { code: "ALREADY_CANCELED_PAYMENT", message: "이미 취소된 결제" };
      if (idemKey) {
        p.idempotency = p.idempotency ?? new Map();
        p.idempotency.set(idemKey, { status: 400, body: err });
      }
      sendJson(res, 400, err);
      return true;
    }
    if (body.refundableAmount != null && Number(body.refundableAmount) !== balance) {
      const err = {
        code: "NOT_MATCHES_REFUNDABLE_AMOUNT",
        message: "환불 가능액 불일치",
      };
      if (idemKey) {
        p.idempotency = p.idempotency ?? new Map();
        p.idempotency.set(idemKey, { status: 400, body: err });
      }
      sendJson(res, 400, err);
      return true;
    }
    if (cancelAmount > balance) {
      const err = { code: "NOT_CANCELABLE_AMOUNT", message: "취소 가능 금액 초과" };
      if (idemKey) {
        p.idempotency = p.idempotency ?? new Map();
        p.idempotency.set(idemKey, { status: 403, body: err });
      }
      sendJson(res, 403, err);
      return true;
    }

    const transactionKey = newTossTxKey();
    p.cancels.push({
      cancelAmount,
      cancelReason: body.cancelReason ?? "",
      transactionKey,
      canceledAt: new Date().toISOString(),
    });
    const canceledSum = p.cancels.reduce((s, c) => s + c.cancelAmount, 0);
    p.status = canceledSum >= p.amount ? "CANCELED" : "PARTIAL_CANCELED";
    p.lastTransactionKey = transactionKey;

    const view = paymentPublicView(p);
    if (idemKey) {
      p.idempotency = p.idempotency ?? new Map();
      p.idempotency.set(idemKey, { status: 200, body: view });
    }

    const webhookUrl = body.webhookUrl || p.webhookUrl;
    setImmediate(() => {
      if (p.dropWebhook) return;
      void postWebhook(webhookUrl, {
        eventType: "PAYMENT_STATUS_CHANGED",
        data: paymentPublicView(p),
      });
    });

    sendJson(res, 200, view);
    return true;
  }

  // Code-B — 일회성 취소 오류 주입
  if (pathname === "/__control/toss/cancel-behavior" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { code: "INVALID_REQUEST", message: "JSON 파싱 실패" });
      return true;
    }
    const p = tossPayments.get(body.paymentKey);
    if (!p) {
      sendJson(res, 404, { code: "NOT_FOUND_PAYMENT", message: "결제 없음" });
      return true;
    }
    const mode = body.mode ?? "off";
    p.cancelBehavior = mode === "off" ? null : mode;
    sendJson(res, 200, { ok: true, mode: p.cancelBehavior });
    return true;
  }

  if (pathname === "/__control/toss/webhook" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { code: "INVALID_REQUEST", message: "JSON 파싱 실패" });
      return true;
    }
    const p = tossPayments.get(body.paymentKey);
    if (!p) {
      sendJson(res, 404, { code: "NOT_FOUND_PAYMENT", message: "결제 없음" });
      return true;
    }
    const webhookUrl = body.webhookUrl || p.webhookUrl;
    const event = {
      eventType: "PAYMENT_STATUS_CHANGED",
      data: paymentPublicView(p),
    };
    const result = await postWebhook(webhookUrl, event);
    sendJson(res, 200, { sent: result });
    return true;
  }

  // PG-7 e2e — /__control/toss/refund
  if (pathname === "/__control/toss/refund" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { code: "INVALID_REQUEST", message: "JSON 파싱 실패" });
      return true;
    }
    const paymentKey = body.paymentKey;
    const p = tossPayments.get(paymentKey);
    if (!p) {
      sendJson(res, 404, { code: "NOT_FOUND_PAYMENT", message: "결제 없음" });
      return true;
    }
    const already = (p.cancels ?? []).reduce((s, c) => s + c.cancelAmount, 0);
    const cancelAmount =
      body.cancelAmount != null ? Number(body.cancelAmount) : Math.max(0, p.amount - already);
    const transactionKey = newTossTxKey();
    p.cancels = p.cancels ?? [];
    p.cancels.push({
      cancelAmount,
      cancelReason: body.cancelReason ?? "e2e refund",
      transactionKey,
      canceledAt: new Date().toISOString(),
    });
    const canceledSum = p.cancels.reduce((s, c) => s + c.cancelAmount, 0);
    p.status = canceledSum >= p.amount ? "CANCELED" : "PARTIAL_CANCELED";
    p.lastTransactionKey = transactionKey;

    const webhookUrl = body.webhookUrl || p.webhookUrl;
    const event = {
      eventType: "PAYMENT_STATUS_CHANGED",
      data: paymentPublicView(p),
    };
    const result = await postWebhook(webhookUrl, event);
    sendJson(res, 200, { payment: paymentPublicView(p), sent: result });
    return true;
  }

  return false;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll('"', "&quot;");
}
