import type { ReactNode } from "react";
import Link from "next/link";
import type { PaymentView } from "@/ui/views/student/payment";
import { FlowHeader } from "@/ui/shell/FlowHeader";
import { Alert, AlertDescription } from "@/ui/shadcn/alert";
import { PaymentFailureDialog } from "@/ui/screens/student/payment/PaymentFailureDialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/shadcn/table";
import { cn } from "@/ui/lib/utils";

export function StudentPaymentScreen({
  view,
  paymentWidget,
}: {
  view: PaymentView;
  paymentWidget: ReactNode;
}) {
  if (view.blockedMessage) {
    return (
      <main className="mx-auto w-full max-w-xl p-8">
        <FlowHeader backHref="/student" backLabel="← 대시보드로" />
        <h1 className="mt-2 text-xl font-bold">결제</h1>
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>
            <p>{view.blockedMessage}</p>
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-xl p-8">
      <FlowHeader backHref="/student" backLabel="← 대시보드로" />
      <h1 className="mt-2 text-xl font-bold">결제</h1>

      {view.banner?.kind === "success" && (
        <Alert className="mt-4 border-green-200 bg-green-50 text-green-800">
          <AlertDescription>
            <p>결제가 확인되었습니다.</p>
          </AlertDescription>
        </Alert>
      )}

      {view.banner?.kind === "notice" && (
        <Alert
          className={cn(
            "mt-4",
            view.banner.tone === "info"
              ? "border-blue-200 bg-blue-50 text-blue-800"
              : "border-amber-200 bg-amber-50 text-amber-800",
          )}
        >
          <AlertDescription>
            <p>{view.banner.text}</p>
          </AlertDescription>
        </Alert>
      )}

      {view.failureMessage && (
        <PaymentFailureDialog orderId={view.orderId} message={view.failureMessage} />
      )}

      {view.unreflectedSuccess && (
        <Alert className="mt-4 border-amber-200 bg-amber-50 text-amber-800">
          <AlertDescription>
            <p>
              결제 이력에 &quot;결제 성공&quot;이 남아 있지만, 아직 이 신청 건에는 반영되지
              않았습니다(결제 정보 확인이 필요한 상태). 결제하셨는데도 이 안내가 보이면
              관리자에게 문의해 주세요.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {view.processedText ? (
        <p className="mt-4 text-sm text-gray-600">{view.processedText}</p>
      ) : view.unpaid ? (
        <>
          <p className="mt-4 text-sm text-gray-600">{view.unpaid.amountText}</p>

          {view.unpaid.widget ? (
            paymentWidget
          ) : (
            <div className="mt-6 rounded-sm border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              <p className="font-medium">아직 결제할 수 없습니다. 남은 조건:</p>
              <ul className="mt-2 list-disc pl-5">
                {view.unpaid.failedRules.map((rule) => (
                  <li key={rule.code}>{rule.message}</li>
                ))}
              </ul>
              {view.unpaid.showDiscordLink && (
                <Link href="/student/profile" className="mt-2 inline-block text-sm underline">
                  디스코드 연결하러 가기
                </Link>
              )}
              {view.unpaid.showTermsLink && (
                <Link href="/terms" className="mt-2 inline-block text-sm underline">
                  약관 다시 동의하러 가기
                </Link>
              )}
            </div>
          )}
        </>
      ) : null}

      <h2 className="mt-10 text-sm font-bold text-gray-700">결제 이력</h2>
      <Table className="mt-2 w-full text-xs">
        <TableHeader>
          <TableRow className="border-b text-left text-gray-500">
            <TableHead className="py-1">시각</TableHead>
            <TableHead>구분</TableHead>
            <TableHead>금액</TableHead>
            <TableHead>수단</TableHead>
            <TableHead>결제사</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.events.map((event) => (
            <TableRow key={event.id} className="border-b">
              <TableCell className="py-1 text-gray-500">{event.timeText}</TableCell>
              <TableCell>{event.label}</TableCell>
              <TableCell>{event.amountText}</TableCell>
              <TableCell>{event.method}</TableCell>
              <TableCell>{event.provider}</TableCell>
            </TableRow>
          ))}
          {view.events.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-2 text-gray-400">
                아직 결제 이력이 없습니다.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </main>
  );
}
