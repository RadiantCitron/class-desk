// AuthShell.tsx — 네비 없는 중앙 정렬 틀. <main>을 렌더한다(Screen의 최상위 = AuthShell).
import type { ReactNode } from "react";
import { cn } from "@/ui/lib/utils";

export function AuthShell({ width = "md", children }: { width?: "md" | "lg"; children: ReactNode }) {
  return (
    <main
      className={cn(
        "mx-auto flex min-h-screen w-full flex-col justify-center gap-4 p-8",
        width === "md" ? "max-w-sm" : "max-w-xl",
      )}
    >
      {children}
    </main>
  );
}
