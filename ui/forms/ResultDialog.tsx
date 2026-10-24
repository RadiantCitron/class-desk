"use client";

import { useState } from "react";
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from "@/ui/shadcn/alert-dialog";
import { Button } from "@/ui/shadcn/button";
import { cn } from "@/ui/lib/utils";

// 서버 액션 결과(성공/실패)를 알리는 팝업. 결과가 있을 때만 마운트해서 쓴다(`{result && <ResultDialog …/>}`) — 닫힘은 부모가 언마운트하는 것뿐이다.
// 배경·ESC로는 닫히지 않고 "확인" 버튼으로만 닫힌다(아무 말 없으면 어떻게 된 일인지 모른다).
// 상태(result)는 폼이 사라져도 마운트가 유지되는 부모가 들고 있어야 한다(ui/forms/useResultAction.ts).
// 열림 여부 콜백을 주지 않는다 = 라이브러리가 닫기를 요청해도 따르지 않는다(이 파일에는 그 콜백 이름이 나오면 안 된다 — modal.guard가 소스 전체를 읽는다).
export function ResultDialog({
  ok,
  message,
  onClose,
}: {
  ok: boolean;
  message: string;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(true);

  const handleClose = () => {
    setOpen(false);
    onClose();
  };

  return (
    <AlertDialog open={open}>
      <AlertDialogContent
        aria-describedby={undefined}
        className="sm:max-w-md"
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <AlertDialogTitle className={cn(ok ? "text-green-700" : "text-red-700")}>
          {ok ? "✔ 처리되었습니다" : "✖ 실패했습니다"}
        </AlertDialogTitle>
        <p role={ok ? "status" : "alert"} className="whitespace-pre-wrap text-sm text-muted-foreground">
          {message}
        </p>
        <div>
          <Button type="button" onClick={handleClose}>
            확인
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
