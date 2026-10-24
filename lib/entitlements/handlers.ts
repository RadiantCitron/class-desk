import { createAdminClient } from "@/lib/supabase/admin";
import { grantDiscordRole, revokeDiscordRole } from "@/lib/discord/bot";

// 이용권 모듈의 이벤트 핸들러 — 다른 모듈이 남긴 사실(아웃박스 메시지)에 반응해 이용권을
// 부여·회수한다(·1-4-10). 반응하는 사실
//   ORDER_PAID     → grantForPaidOrder()        (주문 모듈: 결제가 반영됐다)
//   ORDER_ACCESS_GRANTED → grantForAdminGrantedOrder() (주문 모듈: 관리자가 직권으로 수강권을 줬다, E-2)
//   ORDER_REFUNDED → revokeForRefundedOrder()   (주문 모듈: 환불로 주문이 종료됐다)
//   ORDER_CLOSED   → revokeForClosedOrder()     (주문 모듈: 폐강 중 관리자가 환불 없이 수강을 종료했다, E-4)
//   ORDER_COURSE_ENDED → revokeForEndedCourse() (주문 모듈: 강의가 종료됐다, E-3)
//   USER_WITHDRAWN → revokeAllForWithdrawnUser() (회원 모듈: 탈퇴했다)
// 어떤 토픽이 어떤 핸들러로 가는지는 lib/wiring/outbox.ts(연동표)에만 있다(R3).
//
// entitlements 행 만들기/회수는 DB 함수(grant_entitlements_for_order·
// revoke_entitlements)로 옮겼다. 이 파일에 남은 일은 ① 그 함수를 부르고 ② DB가 할 수 없는 디스코드
// API 호출을 잇는 것뿐이다. 디스코드 ID는 users(회원 모듈)가 아니라 discord_accounts(이용권
// 모듈 자신의 테이블)에서 읽는다 — 2026-09-27부터 link_discord_identity() 자체가 이 모듈 소유로
// 옮겨와 discord_accounts에 직접 쓰므로, 예전에 있던 DISCORD_LINKED 아웃박스 사실 전달·
// recordDiscordLink() 핸들러는 더는 필요 없다(같은 모듈이라 전달할 이유가 없다).

type GrantSpec = {
  type: "COURSE_ACCESS" | "SOURCE_DOWNLOAD" | "DISCORD_ROLE";
  days?: number;
  max_uses?: number;
  discord_role_id?: string;
  blob_pathname?: string;
};

// 회수 사유 — DB 함수 revoke_entitlements의 허용 목록과 같다(ADR-0019). 지금 이 파일이
// 실제로 쓰는 것은 REFUNDED·WITHDRAWN·GRANTS_REISSUED뿐이고, COURSE_ENDED·ADMIN_CLOSED는 그 단계가 사실을 받아 쓴다.
type RevokeReason = "REFUNDED" | "WITHDRAWN" | "COURSE_ENDED" | "ADMIN_CLOSED" | "GRANTS_REISSUED";

type RevokeEntitlementsPayload = {
  user_id: string;
  order_id: string | null;
  reason: RevokeReason;
  type?: string | null;
};

type AdminClient = ReturnType<typeof createAdminClient>;

function requireString(payload: Record<string, unknown>, key: string, topic: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${topic} 페이로드에 ${key}가 없습니다.`);
  }
  return value;
}

async function loadDiscordId(admin: AdminClient, userId: string): Promise<string | null> {
  // users(회원 모듈)가 아니라 discord_accounts(이용권 모듈 자신의 테이블)를 읽는다.
  const { data, error } = await admin
    .from("discord_accounts")
    .select("discord_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`디스코드 연결 조회 실패: ${error.message}`);
  }
  return (data?.discord_id as string | null | undefined) ?? null;
}

// 입구는 하나다(grant_entitlements_for_order) — 길이 여럿일 뿐이다(ADR-0019). 결제(ORDER_PAID)와
// 직권 부여(ORDER_ACCESS_GRANTED, E-2)는 근거(종류, id)만 다르고 부여·디스코드 역할 로직은 아래 한 곳을 같이 쓴다.
type GrantRequest = {
  orderId: string;
  userId: string;
  source: "PAYMENT" | "ADMIN_GRANT";
  sourceId: string;
  grants?: GrantSpec[];
};

async function grantAndAssignRoles(request: GrantRequest) {
  const admin = createAdminClient();

  const { data: rows, error } = await admin.rpc("grant_entitlements_for_order", {
    p_order_id: request.orderId,
    p_user_id: request.userId,
    p_source: request.source,
    p_source_id: request.sourceId,
    p_grants: request.grants ?? null,
  });
  if (error) {
    throw new Error(`권한 부여 실패: ${error.message}`);
  }

  // 디스코드 역할 부여 — "결제 확인된 사람만 정해진 방에 입장". 직권 부여도 같은 길이다.
  // DB 함수는 이미 만든 행 중 회수되지 않은 살아 있는 행만 반환하므로(멱등·F-1), 이 아래가 실패해 메시지가 재시도돼도
  // entitlements가 중복 지급되지 않고, 환불 등으로 회수된 뒤의 늦은 재시도에서 역할이 되살아나지 않는다.
  const discordGrants = (rows ?? []).filter(
    (r: { type: string; metadata: { discord_role_id?: string } | null }) =>
      r.type === "DISCORD_ROLE" && r.metadata?.discord_role_id,
  );
  if (discordGrants.length > 0) {
    const discordId = await loadDiscordId(admin, request.userId);
    // 디스코드 미연결이면 조용히 끝내지 않고 실패로 던진다(2026-10-08 S-1) — 예전엔 기록 없이
    // 처리 완료가 돼 학생 화면에 GRANTED로 보였다. 던지면 아웃박스 재시도·DLQ(OUTBOX)가 그대로
    // 기록하고, 학생이 재시도 기간 안에 연결하면 다음 재시도에서 역할이 나간다(이용권은 위 DB
    // 함수가 멱등이라 중복 지급 없음).
    if (!discordId) {
      throw new Error(
        `디스코드 미연결 — 역할 부여 보류(user_id=${request.userId}, order_id=${request.orderId}). 학생이 디스코드를 연결하면 다음 재시도에서 부여되고, 아니면 디스코드에서 수동 부여 후 해결 처리하세요.`,
      );
    }
    for (const grant of discordGrants) {
      const roleId = (grant.metadata as { discord_role_id: string }).discord_role_id;
      await grantDiscordRole(discordId, roleId);
    }
  }
}

function grantsFrom(rawPayload: Record<string, unknown>): GrantSpec[] | undefined {
  return Array.isArray(rawPayload.grants) ? (rawPayload.grants as GrantSpec[]) : undefined;
}

// 어떤 권한을 얼마나(기간/횟수) 부여할지는 아직 정책이 미정이다(사용자 명시: "아직 결정된 건
// 없으니까 틀만 구현"). grants 스냅샷이 비어 있으면 DB 함수가 기본값(COURSE_ACCESS 1건)으로 부여한다.
// 주문 모듈의 사실 ORDER_PAID({ order_id, user_id, payment_event_id, grants })에 대한 반응.
export async function grantForPaidOrder(rawPayload: Record<string, unknown>) {
  await grantAndAssignRoles({
    orderId: requireString(rawPayload, "order_id", "ORDER_PAID"),
    userId: requireString(rawPayload, "user_id", "ORDER_PAID"),
    source: "PAYMENT",
    sourceId: requireString(rawPayload, "payment_event_id", "ORDER_PAID"),
    grants: grantsFrom(rawPayload),
  });
}

// 주문 모듈의 사실 ORDER_ACCESS_GRANTED({ order_id, user_id, grant_event_id, grants })에 대한 반응 — 관리자 직권 부여.
export async function grantForAdminGrantedOrder(rawPayload: Record<string, unknown>) {
  await grantAndAssignRoles({
    orderId: requireString(rawPayload, "order_id", "ORDER_ACCESS_GRANTED"),
    userId: requireString(rawPayload, "user_id", "ORDER_ACCESS_GRANTED"),
    source: "ADMIN_GRANT",
    sourceId: requireString(rawPayload, "grant_event_id", "ORDER_ACCESS_GRANTED"),
    grants: grantsFrom(rawPayload),
  });
}

// 탈퇴/환불/재부여로 이미 부여한 권한을 회수한다. 순서:
//   1) DB 함수가 접근권부터 회수(강의 접근·다운로드가 즉시 끊긴다), 아직 표시 안 한 대상을 반환.
//   2) still_active(같은 역할의 다른 활성 이용권이 있음)면 디스코드는 안 부르고 표시만 남긴다
//      (옛 TS 로직과 동일한 동작 — "역할을 빼지 않는다"는 API 미호출이지, 표시 생략이 아니다).
//      아니면 디스코드 역할 회수 API를 부른 뒤 표시한다.
async function revokeEntitlements(payload: RevokeEntitlementsPayload) {
  const admin = createAdminClient();

  const { data: pending, error } = await admin.rpc("revoke_entitlements", {
    p_user_id: payload.user_id,
    p_order_id: payload.order_id,
    p_reason: payload.reason,
    p_type: payload.type ?? null,
  });
  if (error) {
    throw new Error(`권한 회수 실패: ${error.message}`);
  }
  if (!pending || pending.length === 0) return;

  const discordId = await loadDiscordId(admin, payload.user_id);

  const failures: string[] = [];
  for (const row of pending) {
    const roleId = row.role_id as string;
    try {
      if (discordId && !row.still_active) {
        await revokeDiscordRole(discordId, roleId);
      }
      const { error: markError } = await admin.rpc("mark_discord_role_removed", {
        p_entitlement_id: row.entitlement_id,
      });
      if (markError) {
        throw new Error(`역할 회수 표시 실패: ${markError.message}`);
      }
    } catch (err) {
      failures.push(`${row.entitlement_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length > 0) {
    // 접근권(DB)은 이미 회수됐다. 남은 디스코드 역할만 메시지 재시도로 다시 시도된다.
    throw new Error(`디스코드 역할 회수 일부 실패(접근권은 회수 완료): ${failures.join("; ")}`);
  }
}

// 주문 모듈의 사실 ORDER_REFUNDED({ order_id, user_id, payment_event_id })에 대한 반응.
export async function revokeForRefundedOrder(rawPayload: Record<string, unknown>) {
  await revokeEntitlements({
    user_id: requireString(rawPayload, "user_id", "ORDER_REFUNDED"),
    order_id: requireString(rawPayload, "order_id", "ORDER_REFUNDED"),
    reason: "REFUNDED",
  });
}

// 주문 모듈의 사실 ORDER_CLOSED({ order_id, user_id, close_event_id })에 대한 반응 — 폐강 중 관리자가 환불 없이 수강을 종료했다.
export async function revokeForClosedOrder(rawPayload: Record<string, unknown>) {
  await revokeEntitlements({
    user_id: requireString(rawPayload, "user_id", "ORDER_CLOSED"),
    order_id: requireString(rawPayload, "order_id", "ORDER_CLOSED"),
    reason: "ADMIN_CLOSED",
  });
}

// 주문 모듈의 사실 ORDER_COURSE_ENDED({ order_id, user_id, offering_id })에 대한 반응 — 강의가 종료됐다. 환불과 무관하게
// 그 강의 주문의 이용권·디스코드 역할을 전부 회수한다(메모리 회수 원칙). 행은 지우지 않는다.
export async function revokeForEndedCourse(rawPayload: Record<string, unknown>) {
  await revokeEntitlements({
    user_id: requireString(rawPayload, "user_id", "ORDER_COURSE_ENDED"),
    order_id: requireString(rawPayload, "order_id", "ORDER_COURSE_ENDED"),
    reason: "COURSE_ENDED",
  });
}

// 회원 모듈의 사실 USER_WITHDRAWN({ user_id })에 대한 반응.
export async function revokeAllForWithdrawnUser(rawPayload: Record<string, unknown>) {
  await revokeEntitlements({
    user_id: requireString(rawPayload, "user_id", "USER_WITHDRAWN"),
    order_id: null,
    reason: "WITHDRAWN",
  });
}

// 개설강의 수정 시 디스코드 역할 교체 + 기존 수강생 재부여(F-9, 경계사례 6).
// ORDER_GRANTS_REISSUED({ order_id, user_id, event_id, from_role, to_role, reason })
// 1) 기존 DISCORD_ROLE 이용권만 회수 (COURSE_ACCESS 등은 불변)
// 2) to_role 이 있으면 새 디스코드 역할 부여 (DB grant_entitlements_for_order + Discord API grantDiscordRole)
export async function reissueGrantsForOrder(rawPayload: Record<string, unknown>) {
  const orderId = requireString(rawPayload, "order_id", "ORDER_GRANTS_REISSUED");
  const userId = requireString(rawPayload, "user_id", "ORDER_GRANTS_REISSUED");
  const eventId = requireString(rawPayload, "event_id", "ORDER_GRANTS_REISSUED");
  const toRole = typeof rawPayload.to_role === "string" ? rawPayload.to_role : null;

  // 1) 기존 디스코드 역할 이용권 회수
  await revokeEntitlements({
    user_id: userId,
    order_id: orderId,
    reason: "GRANTS_REISSUED",
    type: "DISCORD_ROLE",
  });

  // 2) 새 역할이 지정되어 있으면 부여
  if (toRole) {
    const paymentStatus = typeof rawPayload.payment_status === "string" ? rawPayload.payment_status : "PAYMENT";
    const source = paymentStatus === "WAIVED" ? "ADMIN_GRANT" : "PAYMENT";
    await grantAndAssignRoles({
      orderId,
      userId,
      source,
      sourceId: eventId,
      grants: [{ type: "DISCORD_ROLE", discord_role_id: toRole }],
    });
  }
}
