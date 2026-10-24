import Link from "next/link";
import { Badge } from "@/ui/shadcn/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/shadcn/table";
import type { AdminPaymentsView } from "@/ui/views/admin/payments";

export function PaymentsScreen({ view }: { view: AdminPaymentsView }) {
  return (
    <main className="mx-auto w-full max-w-4xl p-8">
      <h1 className="text-xl font-bold">결제 내역</h1>
      <p className="mt-2 text-sm text-gray-500">
        모든 결제 이벤트(원장)를 최신순으로 표시합니다. 조건검색은 아직 없습니다(최근 500건).
      </p>

      <div className="mt-6 overflow-x-auto">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="py-2">시각</TableHead>
              <TableHead>주문</TableHead>
              <TableHead>사용자</TableHead>
              <TableHead>강의</TableHead>
              <TableHead>구분</TableHead>
              <TableHead>금액</TableHead>
              <TableHead>수단</TableHead>
              <TableHead>결제사/거래번호</TableHead>
              <TableHead>상세</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.rows.map((row) => (
              <TableRow key={row.id} className="align-top">
                <TableCell className="whitespace-nowrap py-2 text-gray-400">{row.timeText}</TableCell>
                <TableCell className="whitespace-nowrap font-mono text-xs text-gray-400">
                  {row.orderHref ? (
                    <Link href={row.orderHref} className="font-mono text-gray-400 underline">
                      {row.orderShort}
                    </Link>
                  ) : (
                    "-"
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap font-mono">
                  <span className="font-mono">{row.email}</span>
                </TableCell>
                <TableCell className="whitespace-nowrap">{row.courseText}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Badge variant="outline">{row.label}</Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap">{row.amountText}</TableCell>
                <TableCell>{row.method}</TableCell>
                <TableCell className="whitespace-nowrap text-gray-500">
                  <span className="text-gray-500">{row.providerText}</span>
                </TableCell>
                <TableCell>
                  <details>
                    <summary className="cursor-pointer text-blue-600">JSON</summary>
                    <pre className="mt-1 max-w-sm overflow-x-auto rounded bg-gray-50 p-2">{row.rawJson}</pre>
                  </details>
                </TableCell>
              </TableRow>
            ))}
            {view.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-4 text-gray-400">
                  아직 결제 이벤트가 없습니다.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </main>
  );
}
