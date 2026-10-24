import type { ReactNode } from "react";
import type { NavItemView } from "@/ui/views/shared/nav";
import type { GateBannerData } from "@/ui/views/shared/gate-banner";
import { GateBannerView as GateBanner } from "./GateBannerView";
import { Header } from "./Header";
import { NavLinks } from "./NavLinks";

// 학생 화면 틀. 탭 3개는 탭 화면(/student·/student/entitlements·/student/profile)에서만 보인다: 데스크탑은 좌측 Sidebar, 모바일은 Header 바로 아래 탭바
// (하단 고정 바는 쓰지 않는다 — D3). 신청·결제 화면은 탭 없이 본문 위 FlowHeader만 보인다.
export function StudentShell({
  nav,
  gate,
  signOutAction,
  children,
}: {
  nav: readonly NavItemView[];
  gate: GateBannerData | null;
  signOutAction: () => Promise<void>;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <Header logoHref="/student" />
      <NavLinks items={nav} variant="tabs" ariaLabel="학생 메뉴(모바일)" onlyOnExactMatch />
      <GateBanner data={gate} />
      <div className="flex">
        <NavLinks items={nav} variant="sidebar" ariaLabel="학생 메뉴" onlyOnExactMatch />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      <form id="signout-form" action={signOutAction} />
    </div>
  );
}
