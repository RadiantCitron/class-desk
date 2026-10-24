import type { CommandCode } from "./registry";
import { railVerdict, type RailActor, type RailVerdict } from "./rail";
import { loadRailSwitches } from "./switches";

// 레일 판정 하나를 서버 명령(runCommand)과 화면(버튼·안내)이 같이 쓴다 — 판정이 두 벌 생기지 않게.
// 화면은 이 결과로 버튼을 숨기고 사유를 보여 주고, 실제 차단은 runCommand가 같은 판정으로 다시 한다(2중 방어).
// 스위치는 요청당 1회 읽는다(loadRailSwitches = React cache). 못 읽으면 판정이 거부(fail-closed)다.
export async function checkRail(command: CommandCode, actor: RailActor): Promise<RailVerdict> {
  return railVerdict(command, actor, await loadRailSwitches(actor?.id ?? null));
}
