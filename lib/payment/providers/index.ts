import { createAdminClient } from "@/lib/supabase/admin";
import { UserFacingError } from "@/lib/errors";
import { tossProvider } from "./toss";
import type { PaymentProvider } from "./types";

// 현재 유일한 PG는 토스(페이앱은 2026-10-02 폐기). 새 PG는 이 유니언·URL 세그먼트·resolveProvider·
// payment_settings CHECK·set_payment_provider에 한 줄씩 추가한다(골격 유지).
export type ProviderName = "TOSS";

/** URL 세그먼트(소문자) ↔ DB/어댑터 이름(대문자). 조립·파싱은 여기만. */
export const PROVIDER_URL_SEGMENT: Record<ProviderName, string> = {
  TOSS: "toss",
};

export function providerNameFromUrlSegment(segment: string): ProviderName | null {
  if (segment === "toss") return "TOSS";
  return null;
}

export function urlSegmentForProvider(name: ProviderName): string {
  return PROVIDER_URL_SEGMENT[name];
}

/** PG 이름 문자열 → 어댑터. 대문자만 받는다(payment_settings CHECK와 동일). */
export function resolveProvider(name: ProviderName): PaymentProvider {
  switch (name) {
    case "TOSS":
      return tossProvider;
    default: {
      const _exhaustive: never = name;
      throw new Error(`알 수 없는 결제 제공자: ${_exhaustive}`);
    }
  }
}

export async function getPaymentProvider(): Promise<PaymentProvider> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("payment_settings")
    .select("active_provider")
    .eq("id", "SINGLETON")
    .single();
  if (error || !data?.active_provider) {
    throw new UserFacingError(
      "결제 수단이 아직 준비되지 않았습니다. 잠시 후 다시 시도하거나 관리자에게 문의해 주세요.",
    );
  }
  const name = data.active_provider as string;
  if (name !== "TOSS") {
    throw new Error(`알 수 없는 결제 제공자: ${name}`);
  }
  return resolveProvider(name);
}

export type {
  PaymentProvider,
  CheckoutRequest,
  CheckoutResult,
  ParsedWebhookEvent,
  ReturnQuery,
  CompleteReturnResult,
} from "./types";
