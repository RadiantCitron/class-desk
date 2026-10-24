"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import type { NavItemView } from "@/ui/views/shared/nav";
import { Button } from "@/ui/shadcn/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/ui/shadcn/sheet";
import { NavLinks } from "./NavLinks";

// 모바일 전용 메뉴(md 이상에서는 버튼이 display:none). 시트는 내비게이션 서랍이라 §24 "확인 필수 창"이 아니다 — 바깥 클릭으로 닫혀도 된다.
export function AdminMobileMenu({ items }: { items: readonly NavItemView[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="md:hidden" aria-label="메뉴 열기">
          <Menu aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>메뉴</SheetTitle>
        </SheetHeader>
        <NavLinks items={items} variant="list" ariaLabel="관리자 메뉴(모바일)" onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
