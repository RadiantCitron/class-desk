"use client";

import { useCallback, useState } from "react";
import type { ActionResult } from "@/lib/errors";

// 서버 액션 결과를 "언마운트되지 않는 부모"가 관리하는 훅:
// 서버 액션 성공 직후 `revalidatePath`가 화면 분기를 변경하여 자식 Form 컴포넌트가 언마운트되더라도,
// 부모 레벨에서 결과 상태를 유지하여 알림 대화상자(`<ResultDialog>`)를 안정적으로 표시한다.
export function useResultAction<T = void>(
  action: (prevState: ActionResult<T> | null, formData: FormData) => Promise<ActionResult<T>>,
) {
  const [result, setResult] = useState<ActionResult<T> | null>(null);

  const wrapped = useCallback(
    async (prevState: ActionResult<T> | null, formData: FormData) => {
      const next = await action(prevState, formData);
      setResult(next);
      return next;
    },
    [action],
  );

  const clear = useCallback(() => setResult(null), []);

  return { action: wrapped, result, clear };
}
