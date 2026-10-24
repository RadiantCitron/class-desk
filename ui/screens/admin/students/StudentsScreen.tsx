import Link from "next/link";
import type { AdminStudentsView } from "@/ui/views/admin/students";
import { Badge } from "@/ui/shadcn/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/shadcn/table";

export function StudentsScreen({ view }: { view: AdminStudentsView }) {
  return (
    <main className="mx-auto w-full max-w-3xl p-8">
      <h1 className="text-xl font-bold">수강생 목록</h1>
      <p className="mt-2 text-sm text-gray-500">
        가입한 전체 수강생입니다. 신청·결제 이력은{" "}
        <Link href="/admin/orders" className="underline">
          수강 신청 내역
        </Link>
        에서 확인하세요.
      </p>

      <Table className="mt-6 w-full text-sm">
        <TableHeader>
          <TableRow className="border-b text-left text-gray-500">
            <TableHead className="py-2">이메일</TableHead>
            <TableHead>디스코드 ID</TableHead>
            <TableHead>이름</TableHead>
            <TableHead>전화</TableHead>
            <TableHead>가입일</TableHead>
            <TableHead>상태</TableHead>
            {view.isAdmin && <TableHead>제한</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.rows.map((s) => (
            <TableRow key={s.id} className="border-b">
              <TableCell className="py-2">
                <Link href={s.href} className="font-mono underline">
                  {s.email}
                </Link>
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs">{s.discordId}</span>
              </TableCell>
              <TableCell>{s.name}</TableCell>
              <TableCell>{s.phone}</TableCell>
              <TableCell>
                <span className="whitespace-nowrap text-xs text-gray-400">{s.joinedText}</span>
              </TableCell>
              <TableCell>
                {s.withdrawn ? (
                  <span className="text-gray-400">탈퇴</span>
                ) : (
                  <span className="text-green-700">활동중</span>
                )}
              </TableCell>
              {view.isAdmin && (
                <TableCell>
                  {s.restrictionCount > 0 ? (
                    <Badge variant="destructive">제한 {s.restrictionCount}</Badge>
                  ) : (
                    <span className="text-xs text-gray-400">-</span>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
          {view.rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={view.columnCount} className="py-4 text-gray-400">
                가입한 수강생이 없습니다.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </main>
  );
}
