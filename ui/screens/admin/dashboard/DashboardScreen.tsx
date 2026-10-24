import Link from "next/link";
import type { AdminDashboardView } from "@/ui/views/admin/dashboard";
import { ActionForm, ActionFormError, ActionFormSubmitButton, type FormAction } from "@/ui/forms/ActionForm";
import { Alert, AlertDescription } from "@/ui/shadcn/alert";
import { Card } from "@/ui/shadcn/card";

export function DashboardScreen({
  view,
  drainAction,
}: {
  view: AdminDashboardView;
  drainAction: FormAction;
}) {
  return (
    <main className="mx-auto w-full max-w-xl p-8">
      <h1 className="text-xl font-bold">
        관리자 대시보드
        {!view.isAdmin && <span className="ml-2 text-sm font-normal text-gray-400">(매니저)</span>}
      </h1>

      {view.isAdmin && view.dlqCount !== null && view.dlqCount > 0 && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>
            <p>
              처리되지 않은 오류가 {view.dlqCount}건 있습니다.{" "}
              <Link href="/admin/dlq" className="underline">
                확인하러 가기
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2">
        {view.pendingCount !== null && (
          <Card size="sm" className="p-4">
            <p className="text-xs text-gray-500">승인 대기 신청</p>
            <p className="text-lg font-bold">{view.pendingCount}</p>
            <Link href="/admin/orders" className="text-xs underline">
              신청 내역 보기
            </Link>
          </Card>
        )}
        {view.isAdmin && (
          <Card size="sm" className="p-4">
            <p className="text-xs text-gray-500">미처리 오류(DLQ)</p>
            <p className="text-lg font-bold">{view.dlqCount ?? "—"}</p>
          </Card>
        )}
      </div>

      {view.isAdmin && (
        <ActionForm action={drainAction} className="mt-4">
          <ActionFormSubmitButton variant="outline" size="sm">
            아웃박스 지금 처리
          </ActionFormSubmitButton>
          <ActionFormError className="mt-1 text-xs text-red-600" />
        </ActionForm>
      )}
    </main>
  );
}
