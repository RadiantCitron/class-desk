import { SystemScreen } from "@/ui/screens/admin/system/SystemScreen";
import { loadAdminSystem } from "@/ui/views/admin/system";
import { clearSwitch, setGate, setSwitch } from "./actions";
import { setPaymentProvider } from "./payment-provider-actions";

// 스위치 상태를 매번 새로 읽어야 한다 — 캐시된 페이지를 보여주면 "껐는데 안 꺼짐"이 생긴다(actions.ts가 끝에 revalidatePath를 부르는 것과 짝을 이룬다).
export const dynamic = "force-dynamic";

export default async function AdminSystemPage({ searchParams }: { searchParams: Promise<{ user?: string }> }) {
  const view = await loadAdminSystem(await searchParams);
  return (
    <SystemScreen
      view={view}
      setGateAction={setGate}
      setSwitchAction={setSwitch}
      clearSwitchAction={clearSwitch}
      setProviderAction={setPaymentProvider}
    />
  );
}
