import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/shadcn/table";
import type { OfferingDetailView } from "@/ui/views/admin/course-offering-detail";

type HistoryItem = Extract<OfferingDetailView, { kind: "ok" }>["history"][number];

export function OfferingHistorySection({
  history,
}: {
  history: HistoryItem[];
}) {
  return (
    <section className="mt-8" data-testid="offering-history-section">
      <h2 className="text-lg font-bold">변경 이력 (원장)</h2>
      <p className="mt-1 text-xs text-gray-500">
        개설강의의 생성, 수정, 회차 변동, 상태 변경 등 모든 사건이 불변 원장에 기록됩니다.
      </p>

      {history.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">기록된 이력이 없습니다.</p>
      ) : (
        <div className="mt-3 overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">일시</TableHead>
                <TableHead className="w-28">구분</TableHead>
                <TableHead>내용 / 변경 사항</TableHead>
                <TableHead className="w-40">사유</TableHead>
                <TableHead className="w-36">처리자</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((item) => (
                <TableRow key={item.id} data-testid={`offering-event-${item.id}`}>
                  <TableCell className="text-xs text-gray-600">{item.createdText}</TableCell>
                  <TableCell className="font-medium text-xs">{item.title}</TableCell>
                  <TableCell className="text-xs">{item.detailText || "-"}</TableCell>
                  <TableCell className="text-xs text-gray-600">{item.reason}</TableCell>
                  <TableCell className="text-xs text-gray-500">{item.actorText}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
