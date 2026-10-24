import { Badge } from "@/ui/shadcn/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/shadcn/table";
import type { AdminSystemView } from "@/ui/views/admin/system";
import { SystemGatePanel, type SetGateAction } from "./SystemGatePanel";
import { SwitchSetPanel, type SetSwitchAction } from "./SwitchSetPanel";
import { SwitchClearForm, type ClearSwitchAction } from "./SwitchClearForm";
import { PaymentProviderPanel, type SetProviderAction } from "./PaymentProviderPanel";

// 통제 스위치 관리 화면 하나 — 옛 「시스템 봉쇄」 게이트 목록과 학생 상세의 제한 패널이 여기로 합쳐졌다.
export function SystemScreen({
  view,
  setGateAction,
  setSwitchAction,
  clearSwitchAction,
  setProviderAction,
}: {
  view: AdminSystemView;
  setGateAction: SetGateAction;
  setSwitchAction: SetSwitchAction;
  clearSwitchAction: ClearSwitchAction;
  setProviderAction: SetProviderAction;
}) {
  const { active, history, options, prefillUserEmail } = view.switches;

  return (
    <main className="mx-auto w-full max-w-4xl p-8">
      <h1 className="text-xl font-bold">통제 스위치</h1>
      <p className="mt-2 text-sm text-gray-500">
        시스템 전체·모듈 하나·명령 또는 조회 하나를 전원 또는 특정 회원에게 즉시 막는 밸브입니다. 관리자도 막힘 대상입니다 — 켜져 있는 동안
        관리자의 해당 명령·조회도 막힙니다. 이 화면(스위치 설정·해제)과 로그인·로그아웃만은 언제나 쓸 수 있습니다. 결제 웹훅·크론 같은 사실
        처리는 막지 않습니다.
      </p>

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-lg font-bold">켜져 있는 스위치</h2>
        <SwitchSetPanel options={options} prefillUserEmail={prefillUserEmail} setSwitchAction={setSwitchAction} />
      </div>
      {prefillUserEmail && (
        <p className="mt-1 text-xs text-gray-500">
          학생 상세에서 넘어왔습니다 — 「스위치 설정」을 열면 유저 칸에 {prefillUserEmail}이 채워져 있습니다.
        </p>
      )}

      <div className="mt-3 overflow-x-auto">
        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="py-2">범위</TableHead>
              <TableHead>대상 유저</TableHead>
              <TableHead>사유</TableHead>
              <TableHead>설정자</TableHead>
              <TableHead>설정 시각</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {active.map((row) => (
              <TableRow key={row.id} className="align-top">
                <TableCell className="py-3">
                  <span className="text-xs text-gray-400">{row.levelText}</span>
                  <p className="font-medium">
                    {row.targetText}
                    {row.unknownTarget && (
                      <span className="ml-1 text-xs font-normal text-amber-600">(등록부에 없는 옛 대상)</span>
                    )}
                  </p>
                </TableCell>
                <TableCell>
                  {row.userText === "전원" ? (
                    <Badge variant="destructive">전원</Badge>
                  ) : (
                    <span className="font-mono text-xs text-gray-600">{row.userText}</span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="text-gray-600">{row.reason}</span>
                  {row.staleWarning && <p className="mt-1 max-w-[12rem] text-xs text-amber-600">{row.staleWarning}</p>}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs text-gray-500">{row.setByEmail}</span>
                </TableCell>
                <TableCell>
                  <span className="whitespace-nowrap text-xs text-gray-400">{row.setAtText}</span>
                </TableCell>
                <TableCell>
                  <SwitchClearForm switchId={row.id} clearAction={clearSwitchAction} />
                </TableCell>
              </TableRow>
            ))}
            {active.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-3 text-gray-400">
                  켜져 있는 스위치가 없습니다.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <h2 className="mt-10 text-lg font-bold">해제된 이력</h2>
      <p className="mt-1 text-xs text-gray-400">최근 {history.length}건. 스위치는 지워지지 않고 해제 기록만 남습니다.</p>
      <div className="mt-3 overflow-x-auto">
        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="py-2">범위</TableHead>
              <TableHead>대상 유저</TableHead>
              <TableHead>설정 사유</TableHead>
              <TableHead>설정</TableHead>
              <TableHead>해제 사유</TableHead>
              <TableHead>해제</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.map((row) => (
              <TableRow key={row.id} className="align-top">
                <TableCell className="py-3">
                  <span className="text-xs text-gray-400">{row.levelText}</span>
                  <p className="font-medium">{row.targetText}</p>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs text-gray-600">{row.userText}</span>
                </TableCell>
                <TableCell className="text-gray-600">{row.reason}</TableCell>
                <TableCell>
                  <p className="font-mono text-xs text-gray-500">{row.setByEmail}</p>
                  <p className="whitespace-nowrap text-xs text-gray-400">{row.setAtText}</p>
                </TableCell>
                <TableCell className="text-gray-600">{row.clearedReason}</TableCell>
                <TableCell>
                  <p className="font-mono text-xs text-gray-500">{row.clearedByEmail}</p>
                  <p className="whitespace-nowrap text-xs text-gray-400">{row.clearedAtText}</p>
                </TableCell>
              </TableRow>
            ))}
            {history.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-3 text-gray-400">
                  해제된 이력이 없습니다.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <h2 className="mt-10 text-lg font-bold">감사 기록 스위치</h2>
      <p className="mt-1 text-xs text-gray-400">
        감사 기록 on/off는 명령·조회를 막는 스위치가 아니라 기록 자체를 끄는 별도 스위치입니다(내부 디버깅용).
      </p>
      <div className="mt-3 overflow-x-auto">
        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="py-2">기능</TableHead>
              <TableHead>상태</TableHead>
              <TableHead>사유</TableHead>
              <TableHead>변경자</TableHead>
              <TableHead>변경 시각</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.gates.map((gate) => (
              <TableRow key={gate.code} className="align-top">
                <TableCell className="py-3 font-medium">{gate.label}</TableCell>
                <TableCell>
                  {gate.status === "CLOSED" ? (
                    <Badge variant="destructive">봉쇄됨</Badge>
                  ) : (
                    <Badge variant="secondary" className="bg-green-100 text-green-700">
                      열림
                    </Badge>
                  )}
                  {gate.staleWarning && <p className="mt-1 max-w-[10rem] text-xs text-amber-600">{gate.staleWarning}</p>}
                </TableCell>
                <TableCell>
                  <span className="max-w-[10rem] text-gray-600">{gate.reason}</span>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs text-gray-500">{gate.changedBy}</span>
                </TableCell>
                <TableCell>
                  <span className="whitespace-nowrap text-xs text-gray-400">{gate.changedAtText}</span>
                </TableCell>
                <TableCell>
                  <SystemGatePanel code={gate.code} label={gate.label} status={gate.status} setGateAction={setGateAction} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <PaymentProviderPanel
        current={view.paymentProvider.current}
        reason={view.paymentProvider.reason}
        changedAt={view.paymentProvider.changedAtText}
        changedByEmail={view.paymentProvider.changedByEmail}
        tossKeysConfigured={view.paymentProvider.tossKeysConfigured}
        setProviderAction={setProviderAction}
      />
    </main>
  );
}
