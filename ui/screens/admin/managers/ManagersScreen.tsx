import type { ActionResult } from "@/lib/errors";
import type { FormAction } from "@/ui/forms/ActionForm";
import { ActionForm, ActionFormError, ActionFormSubmitButton } from "@/ui/forms/ActionForm";
import { checkboxClass } from "@/ui/forms/controls";
import { Input } from "@/ui/shadcn/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/shadcn/table";
import type { AdminManagersView } from "@/ui/views/admin/managers";

export function ManagersScreen({
  view,
  grantAction,
  updateAction,
  revokeAction,
}: {
  view: AdminManagersView;
  grantAction: FormAction;
  updateAction: (userId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  revokeAction: (userId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl p-8">
      <h1 className="text-xl font-bold">매니저 관리</h1>
      <div className="mt-6 flex flex-col gap-6 text-sm">
        <ActionForm action={grantAction} className="flex flex-col gap-2 rounded border p-4">
          <h3 className="font-medium">회원을 매니저로 승격</h3>
          <p className="text-xs text-gray-500">
            가입한 회원만 지정할 수 있습니다. 가입할 때 쓴 이메일을 입력하세요(디스코드 연결은 필요 없음).
          </p>
          <Input name="email" type="email" placeholder="이메일" required className="text-xs" />
          <div className="flex flex-wrap gap-4 text-xs">
            <label className="flex items-center gap-1">
              <input type="checkbox" name="can_view_students" className={checkboxClass} /> 수강생 조회
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" name="can_approve_orders" className={checkboxClass} /> 수강신청 승인·반려·취소
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" name="can_approve_payments" className={checkboxClass} /> 결제 승인 (개발 중 — 버튼만)
            </label>
          </div>
          <ActionFormError />
          <ActionFormSubmitButton variant="default" className="mt-2 self-start">
            매니저로 지정
          </ActionFormSubmitButton>
        </ActionForm>

        <div>
          <h3 className="font-medium">현재 매니저 ({view.activeCount}명)</h3>
          <div className="mt-2 overflow-x-auto">
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className="py-2">이메일</TableHead>
                  <TableHead>디스코드</TableHead>
                  <TableHead>이름</TableHead>
                  <TableHead>권한</TableHead>
                  <TableHead>부여자</TableHead>
                  <TableHead>부여일</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.rows.map((row) => (
                  <TableRow key={row.userId} className="align-top">
                    <TableCell className="py-2 font-mono">
                      <span className="font-mono">{row.email}</span>
                    </TableCell>
                    <TableCell className="font-mono text-gray-400">
                      <span className="font-mono text-gray-400">{row.discordId}</span>
                    </TableCell>
                    <TableCell>{row.name}</TableCell>
                    <TableCell>
                      <ActionForm
                        action={updateAction.bind(null, row.userId)}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            name="can_view_students"
                            defaultChecked={row.canViewStudents}
                            className={checkboxClass}
                          />
                          조회
                        </label>
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            name="can_approve_orders"
                            defaultChecked={row.canApproveOrders}
                            className={checkboxClass}
                          />
                          승인
                        </label>
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            name="can_approve_payments"
                            defaultChecked={row.canApprovePayments}
                            className={checkboxClass}
                          />
                          결제
                        </label>
                        <ActionFormSubmitButton className="text-blue-600 underline disabled:text-gray-400">
                          저장
                        </ActionFormSubmitButton>
                        <span className="text-gray-400" title="현재 저장된 권한">
                          {row.permissionsText}
                        </span>
                        <ActionFormError className="text-xs text-red-600" />
                      </ActionForm>
                    </TableCell>
                    <TableCell className="font-mono">
                      <span className="font-mono">{row.grantedBy}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-gray-400">
                      <span className="whitespace-nowrap text-gray-400">{row.grantedText}</span>
                    </TableCell>
                    <TableCell>
                      <ActionForm action={revokeAction.bind(null, row.userId)} className="flex items-center gap-1">
                        <Input name="reason" required placeholder="박탈 사유" className="h-8 w-24 text-xs" />
                        <ActionFormSubmitButton className="text-red-600 underline disabled:text-gray-400">
                          박탈
                        </ActionFormSubmitButton>
                        <ActionFormError className="text-xs text-red-600" />
                      </ActionForm>
                    </TableCell>
                  </TableRow>
                ))}
                {view.rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-4 text-gray-400">
                      현재 지정된 매니저가 없습니다.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </main>
  );
}
