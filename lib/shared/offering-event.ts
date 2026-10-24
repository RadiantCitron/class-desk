export type OfferingEventType =
  | "CREATED"
  | "UPDATED"
  | "STATUS_CHANGED"
  | "CANCEL_STARTED"
  | "CANCEL_COMPLETED"
  | "ENDED"
  | "END_CANCELLED"
  | "DELETED"
  | "SESSION_ADDED"
  | "SESSION_CANCELLED"
  | "SCHEDULE_CHANGED";

export type OfferingEventRow = {
  id: string;
  course_offering_id: string;
  event_type: OfferingEventType;
  actor: "ADMIN" | "SYSTEM";
  actor_user_id: string | null;
  reason: string | null;
  before: any;
  after: any;
  created_at: string;
};

export function formatOfferingEventTitle(row: OfferingEventRow): string {
  switch (row.event_type) {
    case "CREATED":
      return "개설";
    case "UPDATED":
      return "수정";
    case "STATUS_CHANGED":
      return "상태 변경";
    case "CANCEL_STARTED":
      return "폐강 시작";
    case "CANCEL_COMPLETED":
      return "폐강 완료";
    case "ENDED":
      return "강의 종료";
    case "END_CANCELLED":
      return "종료 취소";
    case "DELETED":
      return "삭제";
    case "SESSION_ADDED":
      return "회차 추가";
    case "SESSION_CANCELLED":
      return "회차 취소";
    case "SCHEDULE_CHANGED":
      return "일정 변경";
    default:
      return row.event_type;
  }
}

function formatPrice(price: number): string {
  return `${price.toLocaleString()}원`;
}

export function formatOfferingEventDetail(row: OfferingEventRow): string {
  const parts: string[] = [];

  switch (row.event_type) {
    case "CREATED": {
      if (row.after?.capacity !== undefined) parts.push(`정원 ${row.after.capacity}명`);
      if (row.after?.price !== undefined) parts.push(formatPrice(row.after.price));
      if (Array.isArray(row.after?.sessions)) parts.push(`회차 ${row.after.sessions.length}개`);
      break;
    }

    case "UPDATED": {
      const b = row.before || {};
      const a = row.after || {};
      if (b.price !== undefined || a.price !== undefined) {
        parts.push(`가격 ${formatPrice(b.price ?? 0)} → ${formatPrice(a.price ?? 0)}`);
      }
      if (b.capacity !== undefined || a.capacity !== undefined) {
        parts.push(`정원 ${b.capacity ?? 0}명 → ${a.capacity ?? 0}명`);
      }
      if (b.label !== undefined || a.label !== undefined) {
        parts.push(`강의명 "${b.label}" → "${a.label}"`);
      }
      if (b.auto_approve !== undefined || a.auto_approve !== undefined) {
        parts.push(`자동승인 ${b.auto_approve ? "켜짐" : "꺼짐"} → ${a.auto_approve ? "켜짐" : "꺼짐"}`);
      }
      if (b.notice_text !== undefined || a.notice_text !== undefined) {
        if (!b.notice_text && a.notice_text) {
          parts.push("공지문 등록");
        } else if (b.notice_text && !a.notice_text) {
          parts.push("공지문 삭제");
        } else {
          parts.push("공지문 변경");
        }
      }
      break;
    }

    case "STATUS_CHANGED": {
      const fromStatus = row.before?.status ?? "-";
      const toStatus = row.after?.status ?? "-";
      parts.push(`${fromStatus} → ${toStatus}`);
      break;
    }

    case "SESSION_ADDED": {
      const s = row.after || {};
      const date = s.session_date || s.date || "";
      const start = s.start_time || s.start || "";
      const end = s.end_time || s.end || "";
      if (date) {
        parts.push(`${date} ${start}~${end}`.trim());
      }
      break;
    }

    case "SESSION_CANCELLED": {
      const s = row.before || {};
      const date = s.session_date || s.date || "";
      const start = s.start_time || s.start || "";
      const end = s.end_time || s.end || "";
      if (date) {
        parts.push(`${date} ${start}~${end}`.trim());
      }
      break;
    }

    case "SCHEDULE_CHANGED": {
      const a = row.after || {};
      const cancelledCount = a.cancelled_session_ids?.length ?? 0;
      const addedCount = a.added_session_ids?.length ?? 0;
      parts.push(`취소 ${cancelledCount}개 · 추가 ${addedCount}개`);
      if (a.notified_orders !== undefined) {
        parts.push(`수강생 ${a.notified_orders}명 안내`);
      }
      break;
    }

    case "CANCEL_STARTED": {
      const a = row.after || {};
      if (a.action_required !== undefined) {
        parts.push(`처리 대상 ${a.action_required}명`);
      }
      break;
    }

    case "CANCEL_COMPLETED": {
      break;
    }

    case "ENDED": {
      const a = row.after || {};
      if (a.approved_orders !== undefined) {
        parts.push(`수강생 ${a.approved_orders}명 권한 회수`);
      }
      break;
    }

    case "END_CANCELLED": {
      const a = row.after || {};
      if (a.regranted_orders !== undefined) {
        parts.push(`수강생 ${a.regranted_orders}명 권한 재부여`);
      }
      break;
    }

    case "DELETED": {
      if (row.after?.deleted_reason) {
        parts.push(`사유: ${row.after.deleted_reason}`);
      }
      break;
    }
  }

  return parts.join(" · ");
}
