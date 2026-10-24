// 모듈 지도 — 모듈 5개·계층·경계 규칙(R1~R6)을 코드로 옮긴 유일한 원본.
// lib/architecture/boundaries.guard.test.ts가 이 지도를 기준으로 경계 위반을 잡는다.
// 새 테이블·새 DB 함수·새 폴더를 만들면 반드시 여기에 소속을 적어야 테스트가 통과한다
// ("기능 추가할 때마다 어디가 터질지 모르는 상태"를 막는 장치 — 소속 없는 코드를 허용하지 않는다).

export type ModuleName = "MEMBER" | "ORDER" | "PAYMENT" | "ENTITLEMENT" | "CS";

export const MODULE_LABELS: Record<ModuleName, string> = {
  MEMBER: "회원",
  ORDER: "주문",
  PAYMENT: "결제",
  ENTITLEMENT: "이용권",
  CS: "CS",
};

// 테이블 → 주인 모듈. 주인만 쓴다(R1). 업무 모듈끼리는 읽기도 금지다(2026-09-25 강화 — CS 창구 테이블 조회와
// CS 모듈의 읽기는 예외). 예전 주석 "읽기는 막지 않는다"는 강화 전 서술이었다.
export const TABLE_OWNER: Record<string, ModuleName> = {
  users: "MEMBER",
  terms: "MEMBER",
  terms_agreements: "MEMBER",
  account_events: "MEMBER",
  orders: "ORDER",
  order_events: "ORDER",
  courses: "ORDER",
  course_offerings: "ORDER",
  course_offering_events: "ORDER",
  course_sessions: "ORDER",
  products: "ORDER",
  discount_rules: "ORDER",
  payment_events: "PAYMENT",
  payment_settings: "PAYMENT",
  payment_attempts: "PAYMENT",
  entitlements: "ENTITLEMENT",
  entitlement_uses: "ENTITLEMENT",
  discord_accounts: "ENTITLEMENT",
  audit_logs: "CS",
  dead_letters: "CS",
  outbox_messages: "CS",
  system_gates: "CS",
  manager_permissions: "CS",
  // 명령 레일 CR-2(2026-10-07)부터 쓰기 중지 — 이력만 남는다(상태는 rail_switches).
  student_restrictions: "CS",
  rail_switches: "CS",
};

// CS가 운영하는 "보고 창구". 어느 모듈이든 INSERT할 수 있다(로그를 남기는 것과 같다 —
// 감사 기록, 실패 보관함, 모듈 간 사실 전달 큐). 이 셋을 쓰는 건 R1 위반이 아니다.
export const CS_SINK_TABLES = new Set(["audit_logs", "dead_letters", "outbox_messages"]);

// 테이블을 쓰는 DB 함수 → 주인 모듈. 테이블을 쓰는 함수가 여기 없으면 테스트가 실패한다.
export const FUNCTION_OWNER: Record<string, ModuleName> = {
  complete_signup: "MEMBER",
  link_discord_identity: "ENTITLEMENT",
  record_identity_link_failed: "MEMBER",
  withdraw_user: "MEMBER",
  reactivate_user: "MEMBER",
  sync_my_email: "MEMBER",
  // 읽기 전용이지만 회원 모듈 테이블(terms·terms_agreements)만 보는 회원 함수 — 주인이 없으면 R1(읽기) 검사가
  // "주인 없는 함수의 교차 읽기"로 오판한다(2026-10-06 추가).
  get_pending_terms: "MEMBER",
  create_order: "ORDER",
  transition_order: "ORDER",
  grant_order_access: "ORDER",
  close_order_without_refund: "ORDER",
  settle_unpaid_orders_of_offering: "ORDER",
  end_course_offering: "ORDER",
  reopen_course_offering: "ORDER",
  cancel_own_order: "ORDER",
  create_course_offering: "ORDER",
  delete_course_offering: "ORDER",
  update_course_offering: "ORDER",
  reserve_course_offering_seat: "ORDER",
  release_course_offering_seat: "ORDER",
  on_payment_succeeded: "ORDER",
  on_payment_refunded: "ORDER",
  cancel_orders_for_withdrawn_user: "ORDER",
  record_payment_event: "PAYMENT",
  begin_refund_request: "PAYMENT",
  fail_refund_request: "PAYMENT",
  set_payment_provider: "PAYMENT",
  consume_entitlement: "ENTITLEMENT",
  grant_entitlements_for_order: "ENTITLEMENT",
  revoke_entitlements: "ENTITLEMENT",
  mark_discord_role_removed: "ENTITLEMENT",
  generate_access_code: "ENTITLEMENT",
  set_course_offering_status: "ORDER",
  cancel_course_offering: "ORDER",
  complete_course_offering_cancel: "ORDER",
  revoke_course_offering_cancel: "ORDER",
  set_product_status: "ORDER",
  reset_dead_outbox_message: "CS",
  set_manager: "CS",
  revoke_manager: "CS",
  claim_outbox_messages: "CS",
  // 읽기 전용 헬퍼(쓰기 없음) — R1 읽기 금지 검사가 "소속 모름"으로 오탐하지 않게 소속만 채운다.
  // is_admin/has_permission/current_profile_id/gate_open/assert_manager_eligible은 여러 모듈을
  // 보는 CS 판정 함수라 CS(읽기 예외)로 둔다.
  is_admin: "CS",
  has_permission: "CS",
  current_profile_id: "CS",
  gate_open: "CS",
  assert_manager_eligible: "CS",
  // 주문 자신의 트리거(orders·course_sessions 둘 다 ORDER 소유라 자기 모듈만 본다).
  check_no_student_schedule_conflict: "ORDER",
  // 회차(course_sessions)와 개설강의(course_offerings)는 둘 다 ORDER 소유 — 개강·종료 계산 캐시 트리거와 마지막 활성 회차 보호.
  sync_offering_schedule_from_sessions: "ORDER",
  guard_last_active_session: "ORDER",
  // 개설 후 회차 추가·취소 — course_sessions·course_offerings·orders 모두 ORDER 소유.
  assert_course_sessions_editable: "ORDER",
  add_course_session: "ORDER",
  cancel_course_session: "ORDER",
  // 회차 파생값(총/지난/다음 회차) — course_sessions는 ORDER 소유.
  offering_session_stats: "ORDER",
  // 수강생 환불 신청·거절 — orders·order_events 모두 ORDER 소유. 환불 자체(PG)는 결제 모듈이 하고 여기서는 사실만 남긴다.
  request_order_refund: "ORDER",
  reject_order_refund_request: "ORDER",
  // 수강생이 있는 수업의 일정 변경·안내·제외(단순화) — course_sessions·orders·order_events 모두 ORDER 소유.
  apply_schedule_change: "ORDER",
  exclude_order_for_schedule_change: "ORDER",
  // 지난 회차 기록 정정 및 시작 시각 판정 — ORDER 소유.
  correct_past_session: "ORDER",
  session_has_started: "ORDER",
  // 취소된 주문에 대해 환불하지 않고 마무리 결정 — ORDER 소유.
  decide_no_refund: "ORDER",
  // 개설강의 공지문 등록·수정·삭제 — course_offerings는 ORDER 소유.
  set_course_offering_notice: "ORDER",
  // 일정 변경 안내 메일 발송 사실 기록 — order_events는 ORDER 소유.
  record_schedule_change_email_sent: "ORDER",
};

// 영구 예외 — 의식적으로 허용한 모듈 간 쓰기. 이유를 반드시 적는다.
export const PERMANENT_CROSS_WRITES: { fn: string; table: string; reason: string }[] = [
  {
    fn: "create_order",
    table: "terms_agreements",
    reason: "구매할 때 한 약관 동의는 신청과 한 트랜잭션이어야 한다(원자성)",
  },
  {
    fn: "set_manager",
    table: "users",
    reason: "users.role은 인가(CS) 속성이 회원 행에 물리적으로 붙어 있는 것 — 역할 부여는 CS 소관",
  },
  {
    fn: "revoke_manager",
    table: "users",
    reason: "위와 같음(users.role)",
  },
  {
    fn: "link_discord_identity",
    table: "account_events",
    reason: "디스코드 연결 이력은 회원 통합 타임라인(app/admin/students/[id]/page.tsx:80-91)의 일부 — 이용권 모듈로 소유가 넘어가도 이력 연속성을 끊지 않는다",
  },
];

// 의식적으로 허용한 TS 모듈의 RPC 호출 예외 (사유 명시)
export const PERMANENT_TS_RPC_EXCEPTIONS: { file: string; fn: string; reason: string }[] = [
  {
    file: "lib/notifications/schedule-changed.ts",
    fn: "record_schedule_change_email_sent",
    reason: "일정 변경 메일 발송 성공 사실을 해당 주문의 order_events에 기록",
  },
];

// TS 파일 경로 → 모듈. 위에서부터 먼저 맞는 규칙을 쓴다(더 구체적인 경로를 위에).
// "ENTRY"는 진입점(L4: 화면·서버 액션·라우트) — 여러 모듈을 읽어 조합할 수 있지만,
// 한 파일이 여러 모듈을 "쓰면" 안 된다(R6). "SHARED"는 모든 모듈이 쓰는 기반 코드 — 업무 테이블을 읽거나 쓰지 않는다
// (예외: lib/supabase/ — 세션 → 우리 users.id를 확정하는 L1 어댑터, SHARED_TABLE_ACCESS_EXCEPTIONS).
// R6 한계: 검사는 파일 안의 직접 쓰기만 본다 — 파사드 호출·아웃박스 드레인을 거친 쓰기는 보지 않는다(드레인은 과거형 사실
// 처리라 명령이 아니다, 받아들인 한계).
export type FileKind = ModuleName | "ENTRY" | "SHARED" | "WIRING";

export const FILE_RULES: { prefix: string; kind: FileKind }[] = [
  { prefix: "lib/wiring/", kind: "WIRING" },
  { prefix: "lib/architecture/", kind: "SHARED" },
  // lib/supabase/identity.ts는 계층도의 L1 어댑터(수파인증 → 우리 users.id)다.
  // CS 파이프라인의 1단계(신원)가 이걸 쓰므로 업무 모듈이 아니라 공용 기반으로 둔다.
  { prefix: "lib/supabase/", kind: "SHARED" },
  { prefix: "lib/errors.ts", kind: "SHARED" },
  { prefix: "lib/terms.ts", kind: "MEMBER" },
  { prefix: "lib/member/", kind: "MEMBER" },
  { prefix: "lib/payment/", kind: "PAYMENT" },
  { prefix: "lib/orders/", kind: "ORDER" },
  { prefix: "lib/entitlements/", kind: "ENTITLEMENT" },
  { prefix: "lib/downloads/", kind: "ENTITLEMENT" },
  { prefix: "lib/discord/", kind: "ENTITLEMENT" },
  { prefix: "lib/email/", kind: "SHARED" },
  // 폐강 안내(lib/notifications)는 회원·개설강의를 읽어 메일을 보내고 실패를 DLQ에 남기는 CS 업무다 — 예전엔 SHARED로 둬서
  // 경계 검사를 통째로 건너뛰었다.
  { prefix: "lib/notifications/", kind: "CS" },
  { prefix: "lib/shared/", kind: "SHARED" },
  { prefix: "lib/audit/", kind: "CS" },
  { prefix: "lib/commands/", kind: "CS" },
  { prefix: "lib/integrity/", kind: "CS" },
  { prefix: "lib/outbox/", kind: "CS" },
  { prefix: "lib/system/", kind: "CS" },
  { prefix: "lib/students/", kind: "CS" },
  { prefix: "lib/auth/", kind: "CS" },
  { prefix: "lib/guards/", kind: "CS" },
  { prefix: "app/", kind: "ENTRY" },
  // UI 레이어(2026-10-03 선행작업 A-4). Loader(ui/views)는 화면 진입점의 읽기 부분이라 page.tsx(app/ = ENTRY)와 같은 권한,
  // 나머지 UI(shadcn·forms·shell·screens·lib/utils)는 components/와 같은 SHARED — 업무 테이블을 읽지도 쓰지도 않는다.
  // ui/views/가 반드시 ui/보다 위에 있어야 한다.
  { prefix: "ui/views/", kind: "ENTRY" },
  { prefix: "ui/", kind: "SHARED" },
  { prefix: "components/", kind: "SHARED" },
  { prefix: "proxy.ts", kind: "ENTRY" },
];

// SHARED이지만 업무 테이블을 읽어도 되는 곳 — 세션 → users.id 확정(L1 어댑터).
export const SHARED_TABLE_ACCESS_EXCEPTIONS = ["lib/supabase/"];

// 외주 SDK 패키지를 값으로 import해도 되는 곳(R5 — 어댑터). `import type`은 어디서든 허용.
export const SDK_IMPORT_ALLOWED: { pkg: RegExp; prefixes: string[] }[] = [
  { pkg: /^@supabase\//, prefixes: ["lib/supabase/"] },
];

// CS 코어가 업무 모듈을 import해도 되는 예외(R4) — 둘 다 "읽기 전용"이어야 한다.
export const CS_READ_ONLY_EXCEPTIONS = ["lib/guards/", "lib/integrity/"];

// 모듈 간 사실 전달 토픽(R2) — "보낸 모듈의 과거형 사실"만 허용한다.
export const FACT_TOPICS = [
  "PAYMENT_SUCCEEDED",
  "PAYMENT_REFUNDED",
  "ORDER_PAID",
  "ORDER_REFUNDED",
  "ORDER_ACCESS_GRANTED",
  "ORDER_CLOSED",
  "ORDER_COURSE_ENDED",
  "ORDER_GRANTS_REISSUED",
  "USER_WITHDRAWN",
  "DISCORD_LINKED",
] as const;

export function fileKind(path: string): FileKind | null {
  for (const rule of FILE_RULES) {
    if (path === rule.prefix || path.startsWith(rule.prefix)) return rule.kind;
  }
  return null;
}
