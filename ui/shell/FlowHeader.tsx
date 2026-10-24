// FlowHeader.tsx — 신청·결제·상세 화면 본문 맨 위의 "뒤로" 링크. h1을 만들지 않는다(부록 A G2).
import Link from "next/link";

export function FlowHeader({ backHref, backLabel }: { backHref: string; backLabel: string }) {
  return (
    <nav aria-label="뒤로 가기">
      <Link href={backHref} className="text-sm text-muted-foreground underline">
        {backLabel}
      </Link>
    </nav>
  );
}
