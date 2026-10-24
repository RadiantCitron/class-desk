// 실패를 표현하는 방식을 시스템 전체에서 한 가지로 정한다.
//
// 왜 필요했나: 지금까지 51곳이 제각각 `throw new Error`를 던졌는데, Next.js는 프로덕션에서
// 서버발 에러 메시지를 마스킹한다("a generic message with an identifier",
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md:106-111).
// 그래서 공들여 쓴 한국어 안내가 사용자에게 단 한 줄도 도달하지 않았다. 일반 사용자를
// 전제한 서비스에서 이건 기능 공백이 아니라 구조 공백이다.
//
// 계약(Next.js 문서가 가르는 기준 그대로):
//   - 예상된 실패(사용자가 스스로 고칠 수 있는 것) → 반환값으로 모델링, 메시지를 그대로 노출
//   - 예상 못 한 실패(버그·인프라)                → 그대로 throw, error.tsx가 일반 안내

// 사용자에게 그대로 보여도 되는 실패. 개인정보나 내부 사정이 섞이지 않은 문장만 담는다.
// (예: "이미 신청한 강의입니다" O / "상태 갱신 실패: duplicate key ..." X)
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

// instanceof만으로 판정하지 않는다 — dev 서버의 모듈 재적재(HMR) 중에는 같은 클래스가 서로
// 다른 정체성으로 두 번 로드될 수 있어서, 그때 instanceof가 조용히 false가 된다. name까지
// 함께 보면 그 상황에서도 계약이 유지된다.
export function isUserFacingError(err: unknown): err is Error {
  return (
    err instanceof UserFacingError ||
    (err instanceof Error && err.name === "UserFacingError")
  );
}

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; message: string };

// 서버 액션의 경계에서 쓴다. UserFacingError"만" 잡는 것이 이 함수의 핵심이다:
//   - 예상 못 한 에러를 여기서 삼키면 error.tsx가 못 받는다.
//   - redirect()/notFound()는 Next.js가 특수한 예외를 던져서 동작하는 API다. 넓게 잡으면
//     성공 후 리다이렉트가 통째로 죽는다(이 저장소는 신청·결제·탈퇴 세 액션이 성공 시
//     redirect를 쓴다). UserFacingError만 잡으면 그 예외들은 그대로 통과한다.
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (isUserFacingError(err)) {
      return { ok: false, message: err.message };
    }
    throw err;
  }
}
