"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavItemView } from "@/ui/views/shared/nav";
import { Badge } from "@/ui/shadcn/badge";
import { cn } from "@/ui/lib/utils";

// variant: sidebar = 데스크탑 좌측 목록(md 미만에서는 display:none) / tabs = 모바일 가로 탭바(md 이상에서는 display:none) / list = 시트 안 목록(항상 표시).
// 같은 링크를 Sidebar와 탭바에 두 벌 렌더하므로 반드시 display(hidden·md:hidden)로 숨긴다 — invisible·opacity-0·sr-only는 Playwright가 2개로 센다(부록 A G4).
// onlyOnExactMatch: 현재 경로가 항목 href와 정확히 같을 때만 렌더(학생 탭 화면 3개에서만 탭을 보인다, 부록 A S-3).
export function NavLinks({
  items,
  variant,
  ariaLabel,
  onlyOnExactMatch = false,
  onNavigate,
}: {
  items: readonly NavItemView[];
  variant: "sidebar" | "tabs" | "list";
  ariaLabel: string;
  onlyOnExactMatch?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  if (onlyOnExactMatch && !items.some((item) => item.href === pathname)) return null;

  // 활성 항목: 정확히 같거나(대시보드·학생 홈 제외) 하위 경로이면서 가장 긴 href.
  const activeHref = items
    .filter(
      (item) =>
        pathname === item.href ||
        (item.href !== "/admin" && item.href !== "/student" && pathname.startsWith(`${item.href}/`)),
    )
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        variant === "sidebar" && "hidden w-56 shrink-0 border-r p-3 md:block",
        variant === "tabs" && "border-b md:hidden",
      )}
    >
      <ul className={cn(variant === "tabs" ? "flex" : "flex flex-col gap-1")}>
        {items.map((item) => {
          const active = item.href === activeHref;
          return (
            <li key={item.href} className={cn(variant === "tabs" && "flex-1")}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-md px-3 text-sm hover:bg-accent",
                  variant === "tabs" ? "justify-center" : "justify-between",
                  active && "bg-accent font-medium",
                )}
              >
                {item.label}
                {item.badge ? <Badge variant="secondary">{item.badge}</Badge> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
