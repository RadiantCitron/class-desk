import type { ReactNode } from "react";
import type { NavItemView } from "@/ui/views/shared/nav";
import type { GateBannerData } from "@/ui/views/shared/gate-banner";
import { AdminMobileMenu } from "./AdminMobileMenu";
import { GateBannerView as GateBanner } from "./GateBannerView";
import { Header } from "./Header";
import { NavLinks } from "./NavLinks";

// 관리자 화면 틀. 데스크탑은 좌측 Sidebar(ADMIN_ROUTES에서 권한으로 거른 메뉴, 건수 배지), 모바일은 Header의 메뉴 버튼 → 시트.
export function AdminShell({
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
      <Header logoHref="/admin" menu={<AdminMobileMenu items={nav} />} />
      <GateBanner data={gate} />
      <div className="flex">
        <NavLinks items={nav} variant="sidebar" ariaLabel="관리자 메뉴" />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      <form id="signout-form" action={signOutAction} />
    </div>
  );
}
