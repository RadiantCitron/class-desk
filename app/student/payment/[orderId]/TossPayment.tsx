"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { startPayment } from "./actions";

declare global {
  interface Window {
    // ANONYMOUS: 비회원 결제용 customerKey 값(SDK가 상수로 주면 그것을 쓴다 — 아래 open() 참고).
    TossPayments?: ((clientKey: string) => {
      // 토스 신형 "결제창형"(SDK v2) — 공식 가이드 https://docs.tosspayments.com/guides/v2/payment-widget/integration-window
      // (구버전 payment().requestPayment는 키 종류가 달라 쓰지 않는다)
      widgets: (opts: { customerKey: string }) => {
        setAmount: (amount: { currency: string; value: number }) => Promise<void>;
        renderPaymentWindow: (opts: { orderName: string }) => Promise<{
          on: (event: "paymentRequest" | "cancel", handler: () => void | Promise<void>) => void;
          destroy: () => Promise<void>;
        }>;
        requestPayment: (params: {
          orderId: string;
          orderName: string;
          successUrl: string;
          failUrl: string;
          customerName?: string;
        }) => Promise<void>;
      };
    }) & { ANONYMOUS?: string };
  }
}

type PaymentWindow = {
  on: (event: "paymentRequest" | "cancel", handler: () => void | Promise<void>) => void;
  destroy: () => Promise<void>;
};

// 학생에게 그대로 보여도 되는 안내(우리가 쓴 한국어 문장). 그 밖의 오류(SDK·네트워크 등)는 원문을 화면에 쓰지 않고
// 일반 안내로 바꾸며 원문은 브라우저 콘솔에만 남긴다(예전엔 SDK 원문이 그대로 보였다).
class PaymentNotice extends Error {}

const OPEN_FAILED = "결제창을 열지 못했습니다. 잠시 후 다시 시도하거나, 계속되면 관리자에게 문의해 주세요.";
const REQUEST_FAILED = "결제를 요청하지 못했습니다. 결제되지 않았으니 다시 시도해 주세요.";

function noticeFor(err: unknown, fallback: string): string {
  if (err instanceof PaymentNotice) return err.message;
  console.error("결제창 오류:", err);
  return fallback;
}

function isAllowedSdkUrl(sdkUrl: string): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  try {
    return new URL(sdkUrl).hostname === "js.tosspayments.com";
  } catch {
    return false;
  }
}

function loadSdk(sdkUrl: string): Promise<void> {
  if (window.TossPayments) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = sdkUrl;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new PaymentNotice("결제 모듈을 불러오지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요."));
    document.head.appendChild(script);
  });
}

// 토스 결제창형(widgets) 호출(2026-10-02 중간 이동 페이지 /pg/toss/launch 제거). 순서(공식 가이드):
// widgets() → setAmount() → renderPaymentWindow() → "paymentRequest" 이벤트(사용자가 토스 창의 "결제하기"를 누름) → requestPayment().
// 사용자는 항상 이 결제 페이지에 있다. 구매자가 토스 창을 닫거나 결제를 포기하면 SDK가 "cancel" 이벤트를 준다(공식 결제창형 SDK,
// https://docs.tosspayments.com/sdk/v2/js/payment-window) — 그때 창 참조를 비우고 이 페이지를 서버에서 다시 읽어(router.refresh) 최신 상태를 보여준다.
// 결제 시도(payment_attempts 행, 원장 아님)는 토스 창의 "결제하기"를 누른 뒤 서버 액션 startPayment가 만든다.
// 결제 과정 중 취소·실패는 토스가 failUrl(복귀 라우트)로 보내며 거기서 기록·안내한다(PAY_PROCESS_CANCELED 등).
// 금액은 setAmount로만 전달하고, renderPaymentWindow·requestPayment의 orderName은 같아야 한다.
export default function TossPayment({
  orderId,
  amount,
  orderName,
}: {
  orderId: string;
  amount: number;
  orderName: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const windowRef = useRef<PaymentWindow | null>(null);
  const router = useRouter();

  async function open() {
    setError(null);
    setBusy(true);
    try {
      const clientKey = process.env.NEXT_PUBLIC_TOSS_CLIENT_KEY;
      const sdkUrl = process.env.NEXT_PUBLIC_TOSS_SDK_URL || "https://js.tosspayments.com/v2/standard";
      if (!clientKey) throw new PaymentNotice("결제 설정이 올바르지 않습니다. 관리자에게 문의해 주세요.");
      if (!isAllowedSdkUrl(sdkUrl)) throw new PaymentNotice("결제 설정이 올바르지 않습니다. 관리자에게 문의해 주세요.");
      await loadSdk(sdkUrl);
      if (!window.TossPayments) throw new Error("TossPayments가 없습니다.");

      // 이전에 연 결제창이 남아 있으면 닫고 새로 연다(사용자가 창을 닫은 뒤 다시 누른 경우).
      if (windowRef.current) {
        try {
          await windowRef.current.destroy();
        } catch {
          /* 이미 닫힌 창 */
        }
        windowRef.current = null;
      }

      // customerKey: 공식 SDK 문서는 비회원이면 ANONYMOUS, 회원이면 구매자마다 고유·고정 무작위 값을 쓰라고 한다
      // (https://docs.tosspayments.com/sdk/v2/js/payment-window). 우리는 저장 결제수단 같은 구매자 단위 기능을 쓰지 않아
      // 비회원 값을 쓴다(예전엔 누를 때마다 새 무작위 값이라 어느 쪽에도 맞지 않았다).
      // SDK 상수가 있으면 그 값, 없으면 문서 표기대로 문자열 "ANONYMOUS"(실제 토스에서의 값은 G3에서 확인).
      const customerKey = window.TossPayments.ANONYMOUS ?? "ANONYMOUS";
      const widgets = window.TossPayments(clientKey).widgets({ customerKey });
      await widgets.setAmount({ currency: "KRW", value: amount });
      const paymentWindow = await widgets.renderPaymentWindow({ orderName });
      windowRef.current = paymentWindow;
      paymentWindow.on("cancel", () => {
        if (windowRef.current === paymentWindow) windowRef.current = null;
        router.refresh();
      });
      paymentWindow.on("paymentRequest", async () => {
        try {
          // 사용자가 토스 창에서 "결제하기"를 누른 시점에 결제 시도를 만든다(자격 재검증 포함).
          const res = await startPayment(orderId);
          if (!res.ok) {
            await paymentWindow.destroy().catch(() => {});
            windowRef.current = null;
            setError(res.message);
            return;
          }
          const p = res.data.clientParams;
          if (!p) throw new Error("결제 시작 값이 없습니다.");
          await widgets.requestPayment({
            orderId: p.tossOrderId,
            orderName: p.orderName,
            successUrl: p.successUrl,
            failUrl: p.failUrl,
            customerName: p.customerName || undefined,
          });
        } catch (err) {
          setError(noticeFor(err, REQUEST_FAILED));
        }
      });
    } catch (err) {
      setError(noticeFor(err, OPEN_FAILED));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => void open()}
        disabled={busy}
        className="rounded bg-black px-4 py-2 text-sm text-white disabled:bg-gray-400"
      >
        결제하기
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
