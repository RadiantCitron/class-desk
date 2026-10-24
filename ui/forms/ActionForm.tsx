"use client";

import { createContext, useContext, useActionState, useEffect } from "react";
import type { ActionResult } from "@/lib/errors";
import { useModalClose } from "./Modal";
import { Button } from "@/ui/shadcn/button";

// 에러 계약(lib/errors.ts)을 렌더링에 연결하는 유일한 접점. 학생 폼 3개가 전부 서버
// 컴포넌트라 useActionState를 쓰려면 클라이언트 컴포넌트가 필요한데, 폼마다 만들지 않고
// 이 세트를 재사용한다.
//
// 처음엔 children을 렌더 프롭(state => ReactNode)으로 받게 만들었는데, 실제로 붙여보니
// 런타임에서 "Functions are not valid as a child of Client Components"로 죽었다 — 서버
// 컴포넌트가 클라이언트 컴포넌트에 넘길 수 있는 건 직렬화 가능한 값(=이미 렌더된 JSX
// 트리)뿐이고, 함수(클로저)는 이 경계를 못 건넌다. 그래서 상태를 context로 공유하고,
// <ActionFormError/>·<ActionFormSubmitButton/>이라는 "이미 렌더된 JSX"로 노출하는 형태로
// 바꿨다 — 서버 페이지는 이 둘을 다른 자식들과 똑같이 배치하기만 하면 된다.
/** 서버 액션의 모양. Screen은 이 타입으로 액션을 prop으로 받는다. */
export type FormAction<T = void> = (
  prevState: ActionResult<T> | null,
  formData: FormData,
) => Promise<ActionResult<T>>;

type FormState = { pending: boolean; error: string | null; success: string | null };
const ActionFormContext = createContext<FormState | null>(null);

export function ActionForm<T = void>({
  action,
  children,
  className,
  closeModalOnDone = false,
}: {
  action: FormAction<T>;
  children: React.ReactNode;
  className?: string;
  /** true면 서버 응답(성공·실패)이 오는 순간 이 폼을 감싼 Modal을 닫는다. 결과는 부모가 useResultAction + ResultDialog로 알린다. 기본 false. */
  closeModalOnDone?: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionResult<T> | null, FormData>(
    action,
    null,
  );
  const closeModal = useModalClose();
  useEffect(() => {
    if (closeModalOnDone && state) closeModal();
  }, [closeModalOnDone, state, closeModal]);
  const error = state && !state.ok ? state.message : null;
  const success =
    state && state.ok && typeof state.data === "string" ? (state.data as string) : null;

  return (
    <ActionFormContext.Provider value={{ pending, error, success }}>
      <form action={formAction} className={className}>
        {children}
      </form>
    </ActionFormContext.Provider>
  );
}

export function ActionFormError({ className }: { className?: string }) {
  const ctx = useContext(ActionFormContext);
  if (!ctx?.error) return null;
  return (
    <p role="alert" className={className ?? "text-sm text-red-600"}>
      {ctx.error}
    </p>
  );
}

/** 성공 시 `ActionResult.data`가 문자열이면 그대로 표시(환불 개시 결과 문구 등). */
export function ActionFormSuccess({ className }: { className?: string }) {
  const ctx = useContext(ActionFormContext);
  if (!ctx?.success) return null;
  return (
    <p role="status" className={className ?? "text-sm text-green-700"}>
      {ctx.success}
    </p>
  );
}

export function ActionFormSubmitButton({
  children,
  pendingLabel,
  disabled,
  className,
  variant,
  size,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  disabled?: boolean;
  className?: string;
  /** 주면 shadcn Button으로 렌더한다. 안 주면 모양을 호출한 쪽 className에 맡기는 평범한 <button>(표 안 "승인"·"삭제" 같은 링크 모양 텍스트 버튼용). */
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
}) {
  const ctx = useContext(ActionFormContext);
  const pending = ctx?.pending ?? false;
  const label = pending ? (pendingLabel ?? "처리 중...") : children;
  if (variant === undefined && size === undefined) {
    return (
      <button type="submit" disabled={pending || disabled} className={className}>
        {label}
      </button>
    );
  }
  return (
    <Button type="submit" variant={variant} size={size} disabled={pending || disabled} className={className}>
      {label}
    </Button>
  );
}
