import type { ModuleName } from "@/lib/architecture/module-map";
import type { Permission } from "@/lib/auth/permissions";

// 명령 등록부 — 이 시스템에서 실행될 수 있는 모든 명령(상태 변경)과 조회(화면 읽기)의 유일한 목록이다
// (ADR-0015)
//
// 명령의 소속 모듈은 "어느 칸에 적혔나"로 정해진다 — 1단 키가 모듈이고, 칸 밖에는 명령을 둘 수 없다.
// 호출부는 이름만 넘기고(모듈을 적는 칸이 없다), 레일이 이름으로 칸을 찾는다. 이름은 지금 감사 기록의
// action 값 그대로라 audit_logs 과거 행과 이어진다. 신고한 모듈과 실제 쓰기 대상의 일치는 가드 테스트가
// 본다(규칙: 실제 쓰기 모듈 ⊆ 그 파일 명령들의 등록 모듈).
//
// 나중에 생기는 통제 요구는 이 파일 1줄(새 명령·조회), 스위치 행 1개(새 차단 — 코드 변경 없음),
// lib/commands/rail.ts의 체크 1개(새 통제 종류)로 받는다.

// 누가 실행할 수 있는가 — 이 값이 권한 판정의 유일한 원본이다(판정 함수는 lib/auth/permissions.ts의 whoDenial).
// 예전 가드(requireProfile·requireAdminProfile·requireStaffProfile·requirePermission·assertAdmin 등)와 1:1이었고, 그 가드들은 지웠다.
//   PUBLIC    신원 불필요(로그인·가입 전 화면과 링크 요청)
//   ACTIVE    로그인 + 탈퇴 아님
//   WITHDRAWN 로그인 + 탈퇴 상태 — 계정 복구 전용(app/reactivate/actions.ts의 「탈퇴한 계정이 아닙니다.」)
//   STAFF     ADMIN 또는 MANAGER
//   ADMIN     관리자만
//   anyPermission  그중 하나라도 있으면(ADMIN은 항상 통과)
export type Who =
  | "PUBLIC"
  | "ACTIVE"
  | "WITHDRAWN"
  | "STAFF"
  | "ADMIN"
  | { anyPermission: readonly Permission[] };

export type CommandKind = "COMMAND" | "QUERY";

export type CommandDef = {
  kind: CommandKind;
  who: Who;
  label: string;
  // 통제실 통로(공리) — 스위치 판정과 "스위치를 못 읽으면 거부" 판정을 둘 다 건너뛴다. 역할 검사는 받는다.
  // 관리자도 막히는 레일에서 스위치를 되돌릴 길을 남기기 위한 닫힌 집합이다(v4 1항). 늘리지 않는다.
  axiom?: true;
  // 기록 여부. 생략하면 COMMAND = FULL(시도+결과), QUERY = OFF(거부만 기록). 조회를 기록하려면 그 줄에 FULL만 적는다.
  audit?: "FULL" | "OFF";
};

const STUDENT_DATA_READERS = { anyPermission: ["VIEW_STUDENTS", "APPROVE_ORDERS"] } as const;
const ORDER_APPROVERS = { anyPermission: ["APPROVE_ORDERS"] } as const;

export const COMMANDS_BY_MODULE = {
  MEMBER: {
    // 한 명령에 진입점이 여럿일 수 있다 — 끄면 그 기능의 모든 진입점이 함께 막힌다(v4 7항).
    ACCOUNT_SIGNUP: { kind: "COMMAND", who: "PUBLIC", label: "회원가입" }, // 가입 링크 요청 + 가입 마무리
    LOGIN: { kind: "COMMAND", who: "PUBLIC", label: "로그인", axiom: true }, // 로그인 링크 요청 + 로그인 확정
    LOGOUT: { kind: "COMMAND", who: "PUBLIC", label: "로그아웃", axiom: true },
    ACCOUNT_REACTIVATE: { kind: "COMMAND", who: "WITHDRAWN", label: "탈퇴 계정 복구" },
    TERMS_AGREE: { kind: "COMMAND", who: "ACTIVE", label: "약관 동의" },
    TERMS_REAGREE: { kind: "COMMAND", who: "ACTIVE", label: "약관 재동의" },
    PROFILE_UPDATE: { kind: "COMMAND", who: "ACTIVE", label: "내 정보 수정" },
    ACCOUNT_WITHDRAW: { kind: "COMMAND", who: "ACTIVE", label: "회원 탈퇴" },
    TERMS_VERSION_CREATE: { kind: "COMMAND", who: "ADMIN", label: "약관 새 버전 게시" },

    LOGIN_VIEW: { kind: "QUERY", who: "PUBLIC", label: "로그인 화면", axiom: true },
    SIGNUP_VIEW: { kind: "QUERY", who: "PUBLIC", label: "가입 화면" },
    SIGNUP_COMPLETE_VIEW: { kind: "QUERY", who: "PUBLIC", label: "가입 마무리 화면" },
    TERMS_VIEW: { kind: "QUERY", who: "PUBLIC", label: "약관 동의 화면" },
    REACTIVATE_VIEW: { kind: "QUERY", who: "WITHDRAWN", label: "계정 복구 화면" },
    STUDENT_PROFILE_VIEW: { kind: "QUERY", who: "ACTIVE", label: "내 정보 화면" },
    STUDENT_WELCOME_VIEW: { kind: "QUERY", who: "ACTIVE", label: "약관 재동의 화면" },
    TERMS_NOTICE_VIEW: { kind: "QUERY", who: "ACTIVE", label: "약관 변경 안내" },
    ADMIN_STUDENTS_VIEW: { kind: "QUERY", who: STUDENT_DATA_READERS, label: "수강생 목록" },
    ADMIN_STUDENT_DETAIL_VIEW: { kind: "QUERY", who: STUDENT_DATA_READERS, label: "수강생 상세" },
    ADMIN_TERMS_VIEW: { kind: "QUERY", who: "ADMIN", label: "약관 관리 화면" },
  },
  ORDER: {
    ORDER_APPLY: { kind: "COMMAND", who: "ACTIVE", label: "수강 신청" },
    ORDER_CANCEL_SELF: { kind: "COMMAND", who: "ACTIVE", label: "내 신청 취소" },
    ORDER_REFUND_REQUEST: { kind: "COMMAND", who: "ACTIVE", label: "수강생 환불 신청" }, // 신청만 한다 — 환불은 관리자가 따로
    ORDER_REFUND_REJECT: { kind: "COMMAND", who: "ADMIN", label: "환불 신청 거절" },
    ORDER_APPROVE: { kind: "COMMAND", who: ORDER_APPROVERS, label: "신청 승인" },
    ORDER_REJECT: { kind: "COMMAND", who: ORDER_APPROVERS, label: "신청 거절" },
    ORDER_CANCEL: { kind: "COMMAND", who: ORDER_APPROVERS, label: "신청 취소(관리)" },
    COURSE_OFFERING_END: { kind: "COMMAND", who: "ADMIN", label: "강의 종료" }, // 종강 뒤 정상 종료 + 이용권 전부 회수
    COURSE_OFFERING_END_CANCEL: { kind: "COMMAND", who: "ADMIN", label: "강의 종료 취소" },
    ORDER_CLOSE_WITHOUT_REFUND: { kind: "COMMAND", who: "ADMIN", label: "수강 종료(환불 없이)" }, // 폐강 중 학생별 처리
    ORDER_DECIDE_NO_REFUND: { kind: "COMMAND", who: "ADMIN", label: "환불하지 않고 마무리" }, // 탈퇴 등으로 취소된 주문의 종결 확인
    ORDER_ACCESS_GRANT: { kind: "COMMAND", who: "ADMIN", label: "직권 수강 부여" }, // 결제 없이 수강권 부여(무료)
    COURSE_CREATE: { kind: "COMMAND", who: "ADMIN", label: "과목 생성" },
    COURSE_DELETE: { kind: "COMMAND", who: "ADMIN", label: "과목 삭제" },
    COURSE_OFFERING_CREATE: { kind: "COMMAND", who: "ADMIN", label: "개설강의 생성" },
    COURSE_OFFERING_UPDATE: { kind: "COMMAND", who: "ADMIN", label: "개설강의 수정" },
    COURSE_OFFERING_NOTICE_SET: { kind: "COMMAND", who: "ADMIN", label: "개설강의 공지문 설정" },
    COURSE_OFFERING_STATUS_CHANGE: { kind: "COMMAND", who: "ADMIN", label: "개설강의 상태 변경" },
    COURSE_SESSION_ADD: { kind: "COMMAND", who: "ADMIN", label: "회차 추가" }, // 개강 전·신청 없음일 때만
    COURSE_SESSION_CANCEL: { kind: "COMMAND", who: "ADMIN", label: "회차 취소" },
    COURSE_SESSION_CORRECT: { kind: "COMMAND", who: "ADMIN", label: "회차 기록 정정" }, // 시작된 회차 사후 정정
    COURSE_SCHEDULE_CHANGE: { kind: "COMMAND", who: "ADMIN", label: "일정 변경(수강생 안내)" }, // 신청자가 있는 수업의 일정 변경
    ORDER_SCHEDULE_CHANGE_EXCLUDE: { kind: "COMMAND", who: "ADMIN", label: "일정 변경 수강 제외 처리(미결제·무료)" },
    COURSE_OFFERING_DELETE: { kind: "COMMAND", who: "ADMIN", label: "개설강의 삭제" },
    COURSE_OFFERING_CANCEL: { kind: "COMMAND", who: "ADMIN", label: "개설강의 폐강" },
    COURSE_OFFERING_CANCEL_COMPLETE: { kind: "COMMAND", who: "ADMIN", label: "개설강의 폐강 완료" },
    COURSE_OFFERING_CANCEL_REVOKE: { kind: "COMMAND", who: "ADMIN", label: "개설강의 폐강 철회" },
    DISCOUNT_RULE_CREATE: { kind: "COMMAND", who: "ADMIN", label: "할인 규칙 생성" },
    DISCOUNT_RULE_DELETE: { kind: "COMMAND", who: "ADMIN", label: "할인 규칙 삭제" },

    STUDENT_HOME_VIEW: { kind: "QUERY", who: "ACTIVE", label: "학생 홈 화면" },
    STUDENT_APPLY_VIEW: { kind: "QUERY", who: "ACTIVE", label: "수강 신청 화면" },
    ADMIN_ORDERS_VIEW: { kind: "QUERY", who: STUDENT_DATA_READERS, label: "수강 신청 내역" },
    ADMIN_ORDER_DETAIL_VIEW: { kind: "QUERY", who: STUDENT_DATA_READERS, label: "수강 신청 상세" },
    ADMIN_COURSES_VIEW: { kind: "QUERY", who: "ADMIN", label: "과목 관리 화면" },
    ADMIN_COURSE_OFFERINGS_VIEW: { kind: "QUERY", who: "ADMIN", label: "개설강의 목록" },
    ADMIN_COURSE_OFFERING_DETAIL_VIEW: { kind: "QUERY", who: "ADMIN", label: "개설강의 상세" },
    ADMIN_DISCOUNT_RULES_VIEW: { kind: "QUERY", who: "ADMIN", label: "할인 규칙 화면" },
  },
  PAYMENT: {
    PAYMENT_START: { kind: "COMMAND", who: "ACTIVE", label: "결제 시작" },
    PAYMENT_CONFIRM: { kind: "COMMAND", who: "ACTIVE", label: "결제 확정" },
    PAYMENT_CONFIRM_MANUAL: { kind: "COMMAND", who: "ADMIN", label: "PG 외 결제 반영" },
    PAYMENT_REFUND_REQUEST: { kind: "COMMAND", who: "ADMIN", label: "환불 요청" },
    PAYMENT_REFUND_AUTO: { kind: "COMMAND", who: "ACTIVE", label: "자동 환불" },
    PAYMENT_REFUND_MARK_FAILED: { kind: "COMMAND", who: "ADMIN", label: "환불 실패 표시" },
    PAYMENT_REFUND_MANUAL: { kind: "COMMAND", who: "ADMIN", label: "PG 외 환불 반영" },
    PAYMENT_PROVIDER_SET: { kind: "COMMAND", who: "ADMIN", label: "결제 대행사 선택" },

    STUDENT_PAYMENT_VIEW: { kind: "QUERY", who: "ACTIVE", label: "결제 화면" },
    ADMIN_PAYMENTS_VIEW: { kind: "QUERY", who: "ADMIN", label: "결제 내역 화면" },
    ADMIN_BULK_REFUND_PREVIEW: { kind: "QUERY", who: "ADMIN", label: "일괄 환불 미리보기" },
  },
  ENTITLEMENT: {
    ENTITLEMENT_DOWNLOAD: { kind: "COMMAND", who: "ACTIVE", label: "자료 다운로드" },
    DISCORD_LINK: { kind: "COMMAND", who: "ACTIVE", label: "디스코드 연결" }, // 연결 시작 + 콜백

    STUDENT_ENTITLEMENTS_VIEW: { kind: "QUERY", who: "ACTIVE", label: "내 이용권 화면" },
  },
  CS: {
    RAIL_SWITCH_SET: { kind: "COMMAND", who: "ADMIN", label: "통제 스위치 설정", axiom: true },
    MANAGER_GRANT: { kind: "COMMAND", who: "ADMIN", label: "매니저 지정" },
    MANAGER_UPDATE: { kind: "COMMAND", who: "ADMIN", label: "매니저 권한 변경" },
    MANAGER_REVOKE: { kind: "COMMAND", who: "ADMIN", label: "매니저 해제" },
    OUTBOX_DRAIN_MANUAL: { kind: "COMMAND", who: "ADMIN", label: "아웃박스 수동 처리" },
    DEAD_LETTER_RESOLVE: { kind: "COMMAND", who: "ADMIN", label: "실패 보관함 해결 처리" },
    OUTBOX_MESSAGE_RETRY: { kind: "COMMAND", who: "ADMIN", label: "아웃박스 재시도" },

    RAIL_SWITCH_VIEW: { kind: "QUERY", who: "ADMIN", label: "통제 스위치 화면", axiom: true },
    // 스위치 화면을 감싸는 관리자 틀(메뉴)이라 통로에 넣는다. 건수 배지는 별도 조회(ADMIN_COUNTS_VIEW)라 통로가 아니다.
    ADMIN_SHELL_VIEW: { kind: "QUERY", who: "STAFF", label: "관리자 메뉴", axiom: true },
    ADMIN_COUNTS_VIEW: { kind: "QUERY", who: "STAFF", label: "관리자 메뉴 건수" },
    ADMIN_DASHBOARD_VIEW: { kind: "QUERY", who: "STAFF", label: "관리자 대시보드" },
    ADMIN_MANAGERS_VIEW: { kind: "QUERY", who: "ADMIN", label: "매니저 관리 화면" },
    ADMIN_DLQ_VIEW: { kind: "QUERY", who: "ADMIN", label: "실패 보관함 화면" },
    ADMIN_AUDIT_LOGS_VIEW: { kind: "QUERY", who: "ADMIN", label: "감사 로그 화면" },
  },
} as const satisfies Record<ModuleName, Record<string, CommandDef>>;

type Registry = typeof COMMANDS_BY_MODULE;
export type CommandCode = { [M in keyof Registry]: keyof Registry[M] & string }[keyof Registry];

// 등록부에 적힌 값(kind·who)으로 이름을 골라낸다 — runQuery가 "조회 이름만, 신원이 없어도 되는 조회만 actor가 null일 수 있다"를
// 컴파일 시점에 알도록 한다.
type CodesWhere<Match> = {
  [M in keyof Registry]: { [C in keyof Registry[M]]: Registry[M][C] extends Match ? C : never }[keyof Registry[M]];
}[keyof Registry] &
  string;
export type QueryCode = CodesWhere<{ kind: "QUERY" }>;
export type PublicCode = CodesWhere<{ who: "PUBLIC" }>;

export type ResolvedCommandDef = {
  code: CommandCode;
  module: ModuleName;
  kind: CommandKind;
  who: Who;
  label: string;
  axiom: boolean;
  audit: "FULL" | "OFF";
};

// 칸 구조를 이름 → 정의로 펼친다. 같은 이름이 두 칸에 있으면 여기서 바로 실패한다(이름은 모듈을 넘어 유일).
function flatten(): Map<CommandCode, ResolvedCommandDef> {
  const map = new Map<CommandCode, ResolvedCommandDef>();
  for (const [module, commands] of Object.entries(COMMANDS_BY_MODULE) as [ModuleName, Record<string, CommandDef>][]) {
    for (const [code, def] of Object.entries(commands)) {
      if (map.has(code as CommandCode)) {
        throw new Error(`명령 이름 중복: ${code}`);
      }
      map.set(code as CommandCode, {
        code: code as CommandCode,
        module,
        kind: def.kind,
        who: def.who,
        label: def.label,
        axiom: def.axiom === true,
        audit: def.audit ?? (def.kind === "COMMAND" ? "FULL" : "OFF"),
      });
    }
  }
  return map;
}

const REGISTRY = flatten();

export const ALL_COMMANDS: readonly ResolvedCommandDef[] = [...REGISTRY.values()];

export function commandDef(code: CommandCode): ResolvedCommandDef {
  const def = REGISTRY.get(code);
  if (!def) throw new Error(`등록되지 않은 명령: ${code}`);
  return def;
}

export function isCommandCode(value: string): value is CommandCode {
  return REGISTRY.has(value as CommandCode);
}
