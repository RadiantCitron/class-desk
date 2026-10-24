"use client";

import { useActionState } from "react";
import { type ActionResult } from "@/lib/errors";
import type { WelcomeView } from "@/ui/views/student/welcome";
import { Button } from "@/ui/shadcn/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/ui/shadcn/card";
import { Alert, AlertDescription, AlertTitle } from "@/ui/shadcn/alert";
import { InfoIcon, AlertTriangleIcon } from "lucide-react";
import Link from "next/link";

export function WelcomeScreen({
  view,
  agreeAction,
}: {
  view: WelcomeView;
  agreeAction: (state: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}) {
  const [state, formAction, isPending] = useActionState(agreeAction, null);

  const pendingTerms = view.terms;
  
  if (pendingTerms.length === 0) {
    return (
      <div className="flex h-[80vh] items-center justify-center p-4">
        <Card className="w-full max-w-md text-center shadow-lg">
          <CardHeader>
            <CardTitle className="text-2xl font-bold">환영합니다!</CardTitle>
            <CardDescription className="text-base">학생 대시보드로 이동합니다.</CardDescription>
          </CardHeader>
          <CardFooter className="flex justify-center">
            <Button asChild size="lg">
              <Link href="/student">대시보드로 이동</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-[80vh] items-center justify-center p-4 py-12">
      <Card className="w-full max-w-2xl shadow-lg border-primary/20">
        <form action={formAction}>
          <CardHeader className="bg-muted/30 pb-6">
            <CardTitle className="text-2xl font-bold">약관 업데이트 안내</CardTitle>
            <CardDescription className="text-base mt-2">
              더 나은 서비스 제공을 위해 필수 약관이 업데이트되었습니다. 변경된 내용을 확인하시고 동의해 주세요.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-8 pt-8">
            {state && !state.ok && state.message && (
              <Alert variant="destructive">
                <AlertTriangleIcon className="h-4 w-4" />
                <AlertTitle>오류</AlertTitle>
                <AlertDescription>{state.message}</AlertDescription>
              </Alert>
            )}

            {pendingTerms.map((term) => (
              <div key={term.type} className="space-y-4 rounded-xl border p-5 bg-card shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="w-full">
                    <h3 className="font-semibold text-lg flex items-center gap-2">
                      <span className="bg-primary/10 text-primary px-2 py-0.5 rounded text-sm shrink-0">필수</span>
                      {term.label}
                    </h3>
                    {term.changeSummary && (
                      <Alert className="mt-4 border-l-4 border-l-blue-500 bg-blue-50/50">
                        <InfoIcon className="h-4 w-4 text-blue-600" />
                        <AlertTitle className="text-sm font-bold text-blue-800">변경 요약</AlertTitle>
                        <AlertDescription className="text-sm mt-1 text-blue-700">
                          {term.changeSummary}
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                </div>
                
                <div className="h-48 overflow-y-auto rounded-md border bg-muted/50 p-4 text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                  {term.content}
                </div>
                
                <div className="flex items-center space-x-3 pt-2 bg-primary/5 p-3 rounded-md">
                  <input type="checkbox" id={`term_${term.type}`} name={`term_${term.type}`} required className="h-5 w-5 rounded border-gray-300 text-primary focus:ring-primary" />
                  <label
                    htmlFor={`term_${term.type}`}
                    className="text-sm font-semibold leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer select-none"
                  >
                    위 {term.label}에 동의합니다.
                  </label>
                </div>
              </div>
            ))}
          </CardContent>
          <CardFooter className="flex justify-between gap-4 bg-muted/30 pt-6">
            <Button variant="outline" asChild className="shrink-0">
              <Link href="/student">나중에 하기</Link>
            </Button>
            <Button type="submit" disabled={isPending} className="w-full sm:w-auto">
              {isPending ? "처리 중..." : "동의하고 대시보드로 이동"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
