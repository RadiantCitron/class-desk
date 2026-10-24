import type { EntitlementsView } from "@/ui/views/student/entitlements";
import { Alert, AlertDescription } from "@/ui/shadcn/alert";

export function EntitlementsScreen({ view }: { view: EntitlementsView }) {
  if (view.kind === "restricted") {
    return (
      <main className="mx-auto w-full max-w-xl p-8">
        <h1 className="text-xl font-bold">이용 제한</h1>
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>
            <p>{view.message}</p>
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-xl p-8">
      <h1 className="text-xl font-bold">내 혜택</h1>
      <p className="mt-2 text-sm text-gray-500">
        결제 완료 후 자동으로 부여되는 권한 목록입니다. 소스코드 다운로드는 이 화면의 버튼으로만 받을 수 있고, 한 번
        받으면 횟수가 차감됩니다.
      </p>

      {view.items.length === 0 ? (
        <p className="mt-6 text-sm text-gray-400">아직 부여된 혜택이 없습니다.</p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {view.items.map((item) => (
            <li key={item.id} className="rounded border p-4 text-sm">
              <p className="font-medium">{item.typeLabel}</p>
              {item.courseName && <p className="text-xs text-gray-500">{item.courseName}</p>}
              {item.discord && (
                <p
                  className={`mt-1 text-xs font-medium ${
                    item.discord.tone === "granted"
                      ? "text-green-600"
                      : item.discord.tone === "failed"
                        ? "text-red-600"
                        : "text-amber-600"
                  }`}
                >
                  {item.discord.text}
                </p>
              )}
              <p className="mt-1 font-mono text-xs text-gray-400">{item.codeText}</p>
              <p className="mt-1 text-xs text-gray-400">{item.grantedText}</p>

              {item.footer.kind === "download" && (
                <a href={item.footer.href} className="mt-2 inline-block rounded bg-black px-3 py-1.5 text-xs text-white">
                  다운로드
                </a>
              )}
              {item.footer.kind === "note" && (
                <p className="mt-2 text-xs text-gray-400">{item.footer.text}</p>
              )}
              {item.footer.kind === "status" && (
                <>
                  <p className="mt-2 text-xs text-gray-400">{item.footer.text}</p>
                  {item.footer.channelUrl && (
                    <a
                      href={item.footer.channelUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block rounded bg-[#5865F2] px-3 py-1.5 text-xs text-white"
                    >
                      디스코드 채널로 이동
                    </a>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
