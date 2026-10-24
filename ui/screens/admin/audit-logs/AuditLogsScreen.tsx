import { Alert, AlertDescription } from "@/ui/shadcn/alert";
import { Badge } from "@/ui/shadcn/badge";
import { Button } from "@/ui/shadcn/button";
import { Input } from "@/ui/shadcn/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/shadcn/table";
import type { AdminAuditLogsView } from "@/ui/views/admin/audit-logs";

export function AuditLogsScreen({ view }: { view: AdminAuditLogsView }) {
  return (
    <main className="mx-auto w-full max-w-4xl p-8">
      <h1 className="text-xl font-bold">관리자 조작 로그</h1>
      <p className="mt-2 text-sm text-gray-500">
        강의/개설강의 CRUD, DLQ 처리 등 관리자가 수행한 조작이 자동으로 기록됩니다. 최근 200건만 표시합니다(시도 중 끊긴 기록은 제외).
      </p>

      {view.unresolvedCount > 0 && (
        <Alert className="mt-3 border-amber-200 bg-amber-50 text-amber-800">
          <AlertDescription className="text-amber-800">
            <p>
              미완결 시도 {view.unresolvedCount}건 — 실행이 시작됐지만 성공/실패 기록이 아직 없습니다. 서버가 실행 도중 죽었을 가능성이 있습니다.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          액션
          <Input type="text" name="action" defaultValue={view.filters.action} placeholder="예: MANAGER_GRANT" />
        </label>
        <label className="flex flex-col gap-1">
          행위자(이메일)
          <Input type="text" name="actor" defaultValue={view.filters.actor} />
        </label>
        <label className="flex flex-col gap-1">
          시작일
          <Input type="date" name="from" defaultValue={view.filters.from} />
        </label>
        <label className="flex flex-col gap-1">
          종료일
          <Input type="date" name="to" defaultValue={view.filters.to} />
        </label>
        <Button type="submit">검색</Button>
        {view.hasFilter && (
          <a href="/admin/audit-logs" className="text-xs text-gray-500 underline">
            필터 초기화
          </a>
        )}
      </form>

      <div className="mt-6 overflow-x-auto">
        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="py-2">시각</TableHead>
              <TableHead>관리자</TableHead>
              <TableHead>조작</TableHead>
              <TableHead>결과</TableHead>
              <TableHead>대상</TableHead>
              <TableHead>상세</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.rows.map((row) => (
              <TableRow key={row.id} className="align-top">
                <TableCell className="whitespace-nowrap py-2 text-xs text-gray-400">{row.timeText}</TableCell>
                <TableCell className="whitespace-nowrap font-mono text-xs">
                  <span className="font-mono text-xs">{row.email}</span>
                </TableCell>
                <TableCell className="whitespace-nowrap">{row.action}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {row.failed ? (
                    <Badge variant="destructive">실패</Badge>
                  ) : (
                    <Badge variant="secondary" className="bg-green-100 text-green-700">
                      성공
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-gray-500">
                  <span className="text-xs text-gray-500">{row.targetText}</span>
                </TableCell>
                <TableCell>
                  <pre className="max-w-md overflow-x-auto text-xs text-gray-600">{row.detailJson}</pre>
                </TableCell>
              </TableRow>
            ))}
            {view.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-4 text-sm text-gray-400">
                  조건에 맞는 기록이 없습니다.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </main>
  );
}
