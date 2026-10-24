import Link from "next/link";
import type { ActionResult } from "@/lib/errors";
import { ActionForm, ActionFormError, ActionFormSubmitButton, type FormAction } from "@/ui/forms/ActionForm";
import { Input } from "@/ui/shadcn/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/shadcn/table";
import type { AdminCoursesView } from "@/ui/views/admin/courses";

export type CoursesScreenProps = {
  view: AdminCoursesView;
  createAction: FormAction;
  deleteAction: (courseId: string, prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
};

export function CoursesScreen({ view, createAction, deleteAction }: CoursesScreenProps) {
  return (
    <main className="mx-auto w-full max-w-2xl p-8">
      <h1 className="text-xl font-bold">강의(과목) 관리</h1>
      <p className="mt-2 text-sm text-gray-500">
        여기서는 과목 자체(템플릿)만 관리합니다. 정원·가격·일정이 있는 실제 회차는{" "}
        <Link href="/admin/course-offerings" className="underline">
          개설강의 관리
        </Link>
        에서 만듭니다.
      </p>

      <ActionForm action={createAction} className="mt-6 flex flex-col gap-2 rounded border p-4">
        <h2 className="font-medium">새 강의(과목) 등록</h2>
        <Input name="name" placeholder="강의명" required />
        <Input name="category" placeholder="강의종류 (예: 코딩, 디자인)" />
        <ActionFormError />
        <ActionFormSubmitButton variant="default" className="mt-2 self-start">
          등록
        </ActionFormSubmitButton>
      </ActionForm>

      <Table className="mt-6">
        <TableHeader>
          <TableRow>
            <TableHead>강의명</TableHead>
            <TableHead>종류</TableHead>
            <TableHead className="w-40"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.courses.map((course) => (
            <TableRow key={course.id}>
              <TableCell className="py-2">{course.name}</TableCell>
              <TableCell>{course.category}</TableCell>
              <TableCell>
                <ActionForm action={deleteAction.bind(null, course.id)} className="flex items-center gap-1">
                  <Input
                    name="reason"
                    required
                    placeholder="삭제 사유"
                    className="h-8 w-28 text-xs"
                  />
                  <ActionFormSubmitButton className="text-red-600 underline disabled:text-gray-400">
                    삭제
                  </ActionFormSubmitButton>
                  <ActionFormError className="text-xs text-red-600" />
                </ActionForm>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </main>
  );
}
