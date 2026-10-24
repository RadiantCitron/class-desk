import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/ui/shadcn/button";

// 로그아웃 버튼은 form 속성으로 Shell 맨 끝의 <form id="signout-form">과 연결한다 — Header 안에 <form>을 두면 DOM에서 본문보다 앞서
// `page.locator("form").first()`(e2e admin-managers)가 이 폼을 잡는다(부록 A G1).
export function Header({ logoHref, menu }: { logoHref: string; menu?: ReactNode }) {
  return (
    <header className="flex items-center justify-between gap-2 border-b px-4 py-2">
      <div className="flex items-center gap-1">
        {menu}
        <Link href={logoHref} className="px-2 text-sm font-semibold">
          class-desk
        </Link>
      </div>
      <Button type="submit" form="signout-form" variant="ghost" size="sm">
        로그아웃
      </Button>
    </header>
  );
}
