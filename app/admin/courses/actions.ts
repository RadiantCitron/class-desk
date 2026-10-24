"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { runCommand } from "@/lib/commands/run-command";
import { UserFacingError, runAction, type ActionResult } from "@/lib/errors";

// courses는 과목 "템플릿"이다. 정원/가격/일정 등 실행 정보는 course_offerings(개설강의)에 있다.
// ("강의와 개설강의는 별개다")
//
// 예상된 실패는 UserFacingError + runAction으로 감싼다 — 예전엔
// 그냥 throw new Error였는데, Next.js가 프로덕션에서 서버발 에러 메시지를 마스킹해서 애써 쓴
// 한국어 안내가 관리자에게 한 줄도 안 보였다(lib/errors.ts 머리말 참고).
export async function createCourse(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const name = String(formData.get("name") ?? "").trim();
    const category = String(formData.get("category") ?? "").trim() || null;

    if (!name) {
      throw new UserFacingError("강의명을 입력해 주세요.");
    }

    await runCommand({ command: "COURSE_CREATE", targetTable: "courses" }, async () => {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from("courses")
        .insert({ name, category })
        .select("id")
        .single();

      if (error) {
        throw new Error(`강의 생성 실패: ${error.message}`);
      }

      return { result: null, targetId: data.id, detail: { name, category } };
    });

    revalidatePath("/admin/courses");
  });
}

// 실제로는 지우지 않고 deleted_at만 세팅한다("DB에서 삭제는 없다" 원칙을 카탈로그성 데이터로
// 확대 적용). 이 개설강의를 참조하는 살아있는(숨기지 않은) 개설강의가
// 있으면 그대로 막는다 — 기존에 DB의 ON DELETE RESTRICT가 하던 일을 애플리케이션이 대신한다
// (소프트 삭제는 실제 DELETE가 아니라서 RESTRICT가 걸리지 않기 때문).
export async function deleteCourse(
  courseId: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      throw new UserFacingError("삭제 사유를 입력해 주세요.");
    }

    await runCommand({ command: "COURSE_DELETE", targetTable: "courses" }, async (adminProfile) => {
      const supabase = await createClient();

      const { count } = await supabase
        .from("course_offerings")
        .select("id", { count: "exact", head: true })
        .eq("course_id", courseId)
        .is("deleted_at", null);

      if (count && count > 0) {
        throw new UserFacingError("삭제 실패(개설강의가 있으면 삭제할 수 없습니다).");
      }

      const { error } = await supabase
        .from("courses")
        .update({ deleted_at: new Date().toISOString(), deleted_reason: reason, deleted_by: adminProfile.id })
        .eq("id", courseId);

      if (error) {
        throw new Error(`삭제 실패: ${error.message}`);
      }

      return { result: null, targetId: courseId, detail: { reason } };
    });

    revalidatePath("/admin/courses");
  });
}
