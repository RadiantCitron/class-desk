import { Alert, AlertDescription } from "@/ui/shadcn/alert";
import type { GateBannerData } from "@/ui/views/shared/gate-banner";
import { cn } from "@/ui/lib/utils";

// 문구는 원본(components/GateBanner.tsx)과 글자까지 같다. 같은 문구가 한 요소에만 있어야 한다(`getByText(/결제 봉쇄됨/)` — 부록 A 3-4).
export function GateBannerView({ data }: { data: GateBannerData | null }) {
  if (!data) return null;
  return (
    <Alert
      className={cn(
        "rounded-none border-x-0 border-t-0 px-4 py-2 text-xs",
        data.isAdmin ? "bg-muted text-muted-foreground" : "border-amber-200 bg-amber-50 text-amber-800",
      )}
    >
      <AlertDescription className="text-inherit">
        {/* AlertDescription은 grid라 자식이 여러 개면 세로로 쌓인다 — <p> 하나로 감싼다(00-공통규칙 6-11). */}
        <p>
          {data.isAdmin && <span className="font-medium">[봉쇄 중 — 관리자도 봉쇄 대상입니다(봉쇄 해제만 가능)] </span>}
          {data.items.map((item) => (
            <span key={item.code} className="mr-4">
              {item.text}
            </span>
          ))}
        </p>
      </AlertDescription>
    </Alert>
  );
}
