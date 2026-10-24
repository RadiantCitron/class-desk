import { getCurrentProfile } from "@/lib/supabase/identity";
import { loadRailSwitches } from "@/lib/commands/switches";
import { switchTargetLabel } from "@/lib/commands/switch-input";

// 봉쇄 고지 배너 데이터 — 명령 레일 CR-4부터 통제 스위치(rail_switches)의 "전원 대상" 행을 그대로 보여 준다.
// 층별 이름: 시스템 = 서비스 전체, 모듈 = 모듈 이름(예: 결제), 명령 = 등록부의 한국어 이름(예: 회원가입). 특정 유저 대상 행은
// 배너가 아니라 그 기능 화면의 사유로 보인다. 감사 기록 on/off는 통제 스위치가 아니라서 여기 오지 않는다.
// ADMIN에게는 회색 배너로 — 관리자도 봉쇄 대상이고, 봉쇄 해제(통제실 통로)만 언제나 할 수 있다는 걸 알려 준다.
export type GateBannerData = {
  isAdmin: boolean;
  items: { code: string; text: string }[];
};

export async function loadGateBanner(): Promise<GateBannerData | null> {
  const [snapshot, profile] = await Promise.all([loadRailSwitches(null), getCurrentProfile()]);
  const items = snapshot.readable
    ? snapshot.switches
        .filter((s) => s.userId === null)
        .map((s) => ({ code: s.id, text: `${switchTargetLabel(s.level, s.target)} 봉쇄됨: ${s.reason}` }))
    : // 스위치를 못 읽으면 레일은 전부 거부한다(fail-closed) — 그 사실을 알린다.
      [{ code: "UNREADABLE", text: "이용 제한 상태를 확인할 수 없어 일시적으로 이용이 제한됩니다" }];
  if (items.length === 0) return null;

  return { isAdmin: profile?.role === "ADMIN", items };
}
