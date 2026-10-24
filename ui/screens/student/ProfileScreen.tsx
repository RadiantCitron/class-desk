import type { ProfileView } from "@/ui/views/student/profile";
import { Alert, AlertDescription } from "@/ui/shadcn/alert";
import { Button } from "@/ui/shadcn/button";
import { Input } from "@/ui/shadcn/input";
import { Textarea } from "@/ui/shadcn/textarea";
import { checkboxClass } from "@/ui/forms/controls";
import { CopyButton } from "@/ui/forms/CopyButton";
import { ActionForm, ActionFormError, ActionFormSubmitButton, type FormAction } from "@/ui/forms/ActionForm";

export function ProfileScreen({
  view,
  updateProfileAction,
  withdrawAction,
  startDiscordLinkAction,
}: {
  view: ProfileView;
  updateProfileAction: FormAction;
  withdrawAction: FormAction;
  startDiscordLinkAction: () => Promise<void>;
}) {
  return (
    <main className="mx-auto w-full max-w-xl p-8">
      <h1 className="text-xl font-bold">내 정보</h1>

      {view.linkedBanner && (
        <Alert className="mt-4 border-green-200 bg-green-50 text-green-800">
          <AlertDescription>
            <p>디스코드 계정이 연결됐습니다.</p>
          </AlertDescription>
        </Alert>
      )}

      {view.linkErrorMessage && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>
            <p>{view.linkErrorMessage}</p>
          </AlertDescription>
        </Alert>
      )}

      {view.joinError && (
        <Alert className="mt-4 border-amber-200 bg-amber-50 text-amber-900">
          <AlertDescription>
            <p>
              디스코드 연결은 됐지만 서버 자동 입장에는 실패했습니다.
              {view.joinError.inviteUrl ? (
                <>
                  {" "}
                  <a href={view.joinError.inviteUrl} target="_blank" rel="noreferrer" className="underline">
                    이 초대링크
                  </a>
                  로 직접 입장해 주세요.
                </>
              ) : (
                " 다시 시도해 주세요."
              )}
            </p>
          </AlertDescription>
        </Alert>
      )}

      <div className="mt-4 flex items-center gap-2 text-sm text-gray-600">
        {view.discordId ? (
          <>
            <span>
              디스코드 ID: <span className="font-mono">{view.discordId}</span>
            </span>
            <CopyButton text={view.discordId} />
          </>
        ) : (
          <form action={startDiscordLinkAction}>
            <Button type="submit" className="bg-[#5865F2] text-white hover:bg-[#4752c4]">
              디스코드 연결
            </Button>
          </form>
        )}
      </div>

      <p className="mt-1 text-sm text-gray-600">이메일: {view.email}</p>

      <ActionForm action={updateProfileAction} className="mt-6 flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          이름
          <Input name="name" defaultValue={view.form.name} />
        </label>
        <label className="flex flex-col gap-1">
          전화번호
          <Input name="phone" defaultValue={view.form.phone} />
        </label>
        <label className="flex flex-col gap-1">
          성별
          <select
            name="gender"
            defaultValue={view.form.gender}
            className="rounded-sm border px-3 py-1.5 text-sm"
          >
            <option value="UNSPECIFIED">선택 안 함</option>
            <option value="M">남성</option>
            <option value="F">여성</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          생년월일
          <Input type="date" name="birth_date" defaultValue={view.form.birthDate} />
        </label>
        <label className="flex flex-col gap-1">
          비고
          <Textarea name="note" defaultValue={view.form.note} />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="marketing_email_opt_in"
            defaultChecked={view.form.marketingOptIn}
            className={checkboxClass}
          />
          광고성 정보(이메일) 수신에 동의합니다(선택 — 언제든 해제할 수 있습니다).
        </label>
        <ActionFormError />
        <ActionFormSubmitButton variant="default" className="mt-2 self-start">
          저장
        </ActionFormSubmitButton>
      </ActionForm>

      <div className="mt-10 rounded border border-red-200 p-4">
        <h2 className="font-medium text-red-700">탈퇴</h2>
        <p className="mt-1 text-xs text-gray-500">
          탈퇴 시 계정 정보는 삭제되지 않고 보관 처리됩니다(수강·결제 분쟁 대응을 위해 탈퇴일로부터 3년간 보관 후
          파기). 탈퇴하면 받은 이용권과 디스코드 역할이 회수됩니다. 나중에 같은 이메일로 로그인하면 계정을 복구할
          수 있지만, 회수된 이용권·역할은 돌아오지 않습니다. 오조작 방지를 위해 본인 이메일을 입력해야 진행됩니다.
        </p>
        {view.activeOrderCount > 0 && (
          <div className="mt-2 rounded bg-red-50 p-3 text-xs text-red-700">
            <p className="font-medium">
              현재 신청·수강 중인 강의가 {view.activeOrderCount}건 있습니다. 탈퇴하면 결제 여부와 관계없이 전부
              취소됩니다(환불이 필요한 결제 건은 별도로 처리됩니다).
            </p>
            <ul className="mt-2 list-disc pl-5">
              {view.activeOrders.map((o) => (
                <li key={o.id}>
                  {o.title} {o.isPaid ? "(결제 완료)" : "(미결제 신청)"}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ActionForm action={withdrawAction} className="mt-3 flex flex-col gap-2">
          {view.paidOrderCount > 0 && (
            <label className="flex items-center gap-2 text-xs font-medium text-red-800">
              <input
                type="checkbox"
                name="confirm_paid_orders_cancel"
                required
                className={checkboxClass}
              />
              결제 완료된 수업이 진행 중임을 확인하였으며, 탈퇴 시 자동 환불되지 않고 관리자 확인 후 처리됨에 동의합니다.
            </label>
          )}
          <Input name="confirm_email" type="email" required placeholder="본인 이메일 입력" />
          <ActionFormError />
          <ActionFormSubmitButton pendingLabel="처리 중..." variant="destructive" className="self-start">
            탈퇴하기
          </ActionFormSubmitButton>
        </ActionForm>
      </div>
    </main>
  );
}
