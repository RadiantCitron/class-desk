import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// 확정 모달은 "무조건 확인해야 하는 창"이어야 한다(어두운 배경을 눌렀을 때 창이 사라지는 것이 비정상).
// 네이티브 <dialog>+useStrictDialog에서 shadcn AlertDialog 래퍼로 바뀌어 구조 검사를 새 구현에 맞췄다.
// 컴포넌트 렌더 테스트 도구(jsdom 등)가 이 저장소에 없어 동작은 e2e(system-gates·admin-refund-ui·admin-system-provider)가 맡고 이 파일은 구조만 지킨다.
function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf-8");
}

const WRAPPERS = ["ui/forms/Modal.tsx", "ui/forms/ResultDialog.tsx"];

describe("확인 필수 모달 구조 가드(AlertDialog 기반)", () => {
  it("Modal·ResultDialog는 AlertDialog를 쓰고, 배경 클릭으로 닫히는 Dialog 부품은 쓰지 않는다", () => {
    for (const file of WRAPPERS) {
      const source = read(file);
      expect(source, file).toMatch(/@\/ui\/shadcn\/alert-dialog/);
      expect(source, file).not.toMatch(/@\/ui\/shadcn\/dialog/);
    }
  });

  it("Modal·ResultDialog는 ESC로 닫히는 기본 동작을 막는다(onEscapeKeyDown + preventDefault)", () => {
    for (const file of WRAPPERS) {
      const source = read(file);
      expect(source, file).toMatch(/onEscapeKeyDown=\{\(\w+\)\s*=>\s*\w+\.preventDefault\(\)\}/);
    }
  });

  it("Modal은 라이브러리의 닫기 요청을 따르지 않는다(onOpenChange가 열기만 받는다)", () => {
    const modal = read("ui/forms/Modal.tsx");
    expect(modal).toMatch(/onOpenChange=/);
    expect(modal).toMatch(/if\s*\(next\)\s*setOpen\(true\)/);
    expect(modal).not.toMatch(/onOpenChange=\{setOpen\}/);
  });

  it("ResultDialog는 onOpenChange를 주지 않는다(닫는 방법은 확인 버튼 → onClose뿐)", () => {
    expect(read("ui/forms/ResultDialog.tsx")).not.toMatch(/onOpenChange/);
  });

  it("봉쇄 패널은 상태가 바뀌면 모달 인스턴스가 바뀌도록 key를 준다(열린 채 제목만 바뀌는 현상 방지)", () => {
    const panel = read("ui/screens/admin/system/SystemGatePanel.tsx");
    expect(panel).toMatch(/key=\{status\}/);
    expect(panel).toMatch(/useResultAction/);
    expect(panel).toMatch(/ResultDialog/);
  });
});
