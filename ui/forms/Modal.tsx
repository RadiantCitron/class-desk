"use client";

import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/ui/shadcn/alert-dialog";
import { Button } from "@/ui/shadcn/button";

// 이 저장소의 Modal은 전부 확정 폼이라 "무조건 확인해야 하는 창"이다.
// 배경을 누르거나 ESC를 눌러도 닫히지 않고, 창 안의 "닫기" 버튼 또는 확정 결과 뒤 ActionForm의 closeModalOnDone으로만 닫힌다.
// 네이티브 <dialog>+useStrictDialog를 shadcn AlertDialog(Radix)로 교체했다 — 바깥 클릭 닫힘은 AlertDialog가 원래 막고,
// ESC는 onEscapeKeyDown으로 막고, onOpenChange는 "열기"만 받는다(닫기는 close()뿐).
// 주의: 열려 있을 때만 DOM에 있다(portal) — 닫으면 안의 폼 상태는 사라진다. 결과 알림은 닫혀도 남는 부모가 useResultAction + ResultDialog로 맡는다.
const noop = () => {};
const ModalCloseContext = createContext<() => void>(noop);

/** 이 Modal 안에서 호출하면 허용된 방식으로 모달을 닫는다(Modal 밖이면 아무 일도 없다). */
export function useModalClose(): () => void {
  return useContext(ModalCloseContext);
}

export function Modal({
  triggerLabel,
  title,
  contentClassName,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  children,
}: {
  triggerLabel?: string;
  title: string;
  contentClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    controlledOnOpenChange?.(false);
  }, [controlledOnOpenChange]);

  const effectiveOpen = controlledOpen !== undefined ? controlledOpen : open;

  return (
    <AlertDialog
      open={effectiveOpen}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        if (next) controlledOnOpenChange?.(true);
      }}
    >
      {triggerLabel && (
        <AlertDialogTrigger asChild>
          <Button type="button" size="sm">
            {triggerLabel}
          </Button>
        </AlertDialogTrigger>
      )}
      <AlertDialogContent
        aria-describedby={undefined}
        className={contentClassName ?? "max-h-[80vh] overflow-y-auto sm:max-w-2xl"}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <div className="flex items-center justify-between gap-4">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <Button type="button" variant="ghost" size="sm" aria-label="닫기" onClick={close}>
            닫기
          </Button>
        </div>
        <ModalCloseContext.Provider value={close}>
          <div>{children}</div>
        </ModalCloseContext.Provider>
      </AlertDialogContent>
    </AlertDialog>
  );
}
