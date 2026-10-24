import Link from "next/link";
import type { StudentDetailView, StudentTimelineKind } from "@/ui/views/admin/student-detail";
import { FlowHeader } from "@/ui/shell/FlowHeader";
import { Badge } from "@/ui/shadcn/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/shadcn/table";

const KIND_STYLE: Record<StudentTimelineKind, string> = {
  AUDIT: "bg-purple-100 text-purple-700",
  ENROLLMENT: "bg-blue-100 text-blue-700",
  PAYMENT: "bg-green-100 text-green-700",
  ACCOUNT: "bg-yellow-100 text-yellow-700",
};

export function StudentDetailScreen({ view }: { view: StudentDetailView }) {
  if (view.kind === "notFound") {
    return (
      <main className="mx-auto w-full max-w-3xl p-8">
        <h1 className="text-xl font-bold">수강생을 찾을 수 없습니다</h1>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl p-8">
      <FlowHeader backHref="/admin/students" backLabel="← 수강생 목록" />
      <h1 className="mt-2 text-xl font-bold">{view.title}</h1>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <dt className="text-gray-500">디스코드 ID</dt>
        <dd>
          <span className="font-mono">{view.discordId ?? "미연결"}</span>
        </dd>
        <dt className="text-gray-500">이메일</dt>
        <dd>{view.email}</dd>
        <dt className="text-gray-500">전화</dt>
        <dd>{view.phone}</dd>
        <dt className="text-gray-500">가입일</dt>
        <dd>{view.joinedText}</dd>
        <dt className="text-gray-500">상태</dt>
        <dd>{view.statusText}</dd>
      </dl>

      <h2 className="mt-8 text-lg font-bold">수강 내역</h2>
      <Table className="mt-2 w-full text-sm">
        <TableHeader>
          <TableRow className="border-b text-left text-gray-500">
            <TableHead className="py-2">강의</TableHead>
            <TableHead>신청일</TableHead>
            <TableHead>수강상태</TableHead>
            <TableHead>결제상태</TableHead>
            <TableHead>결제금액</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.orders.map((o) => (
            <TableRow key={o.id} className="border-b">
              <TableCell className="py-2">{o.itemName}</TableCell>
              <TableCell className="text-gray-500">{o.createdText}</TableCell>
              <TableCell>{o.statusText}</TableCell>
              <TableCell>{o.paymentText}</TableCell>
              <TableCell>{o.amountText}</TableCell>
              <TableCell>
                <Link href={o.href} className="text-blue-600 underline">
                  주문 상세
                </Link>
              </TableCell>
            </TableRow>
          ))}
          {view.orders.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-2 text-gray-400">
                신청 내역이 없습니다.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <h2 className="mt-8 text-lg font-bold">이용 제한</h2>
      {view.switches === null ? (
        <p className="mt-1 text-xs text-gray-400">
          {view.isAdmin ? "스위치 상태를 확인할 수 없습니다. 잠시 후 새로고침해 주세요." : "스위치 상태는 ADMIN에게만 보입니다."}
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs text-gray-500">
            이 학생에게만 켜져 있는 통제 스위치입니다(전원 대상 스위치는 포함하지 않습니다). 설정과 해제는{" "}
            <Link href={view.switchScreenHref} className="text-blue-600 underline">
              통제 스위치 화면
            </Link>
            에서 합니다 — 이 학생이 유저 칸에 미리 채워집니다.
          </p>
          <Table className="mt-3 w-full text-sm">
            <TableHeader>
              <TableRow className="border-b text-left text-gray-500">
                <TableHead className="py-2">범위</TableHead>
                <TableHead>상태</TableHead>
                <TableHead>사유</TableHead>
                <TableHead>설정 시각</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.switches.map((row) => (
                <TableRow key={row.id} className="border-b align-top">
                  <TableCell className="py-3">
                    <span className="text-xs text-gray-400">{row.levelText}</span>
                    <p className="font-medium">{row.targetText}</p>
                  </TableCell>
                  <TableCell>
                    <Badge variant="destructive">제한됨</Badge>
                  </TableCell>
                  <TableCell className="max-w-[12rem] text-gray-600">{row.reason}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-gray-400">{row.setAtText}</TableCell>
                </TableRow>
              ))}
              {view.switches.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-2 text-gray-400">
                    이 학생에게 켜져 있는 스위치가 없습니다.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </>
      )}

      <h2 className="mt-8 text-lg font-bold">활동 기록</h2>
      {!view.isAdmin && (
        <p className="mt-1 text-xs text-gray-400">
          활동 기록(신청·결제 이력, 회원 이벤트, 관리자 조작 로그)은 ADMIN에게만 보입니다. 위 수강 내역 표에서 주문 상세로 들어갈 수 있습니다.
        </p>
      )}
      <ul className="mt-3 flex flex-col gap-2">
        {view.timeline.map((item) => (
          <li key={item.id} className="flex items-start gap-3 rounded border p-3 text-sm">
            <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${KIND_STYLE[item.kind]}`}>{item.kindLabel}</span>
            <div>
              {item.href ? (
                <Link href={item.href} className="font-medium underline">
                  {item.label}
                </Link>
              ) : (
                <p className="font-medium">{item.label}</p>
              )}
              <p className="text-xs text-gray-500">{item.detail}</p>
              <p className="text-xs text-gray-400">{item.timeText}</p>
            </div>
          </li>
        ))}
      </ul>
      {view.timeline.length === 0 && <p className="text-sm text-gray-400">기록이 없습니다.</p>}
    </main>
  );
}
