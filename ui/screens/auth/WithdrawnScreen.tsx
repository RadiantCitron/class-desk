import Link from "next/link";
import { AuthShell } from "@/ui/shell/AuthShell";

// 탈퇴 완료 안내. /admin·/student 접근 시 withdrawn_at이 있으면 proxy.ts가 로그아웃 후 여기로 보낸다.
export function WithdrawnScreen() {
  return (
    <AuthShell width="lg">
      <h1 className="text-xl font-bold">탈퇴 처리되었습니다</h1>
      <p className="text-sm text-muted-foreground">
        본 서비스 접속 및 수강 페이지 접근이 즉시 제한되었습니다. 수강 및 결제 분쟁 대응을 위해 신청 기록은 탈퇴일로부터 3년간 보관 후 파기됩니다.
      </p>
      <p className="text-sm text-muted-foreground">원하시면 디스코드 설정에서 직접 이 서비스의 앱 연결을 해제할 수 있습니다.</p>
      <p className="text-sm text-muted-foreground">
        같은 이메일로 다시 로그인하면 계정을 복구할 수 있습니다(회수된 이용권·디스코드 역할은 돌아오지 않습니다).
      </p>
      <Link href="/login" className="inline-block text-sm underline">
        로그인 화면으로
      </Link>
    </AuthShell>
  );
}
