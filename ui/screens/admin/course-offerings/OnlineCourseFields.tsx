"use client";

import { useState } from "react";
import { checkboxClass } from "@/ui/forms/controls";
import { Input } from "@/ui/shadcn/input";
import { cn } from "@/ui/lib/utils";

// 개설·수정 폼 공용 "온라인(디스코드) 수업" 설정(수정에서만이 아니라 개설할 때도 설정).
// 저장 규칙은 하나다: 온라인 수업 = grants에 역할 ID가 있는 DISCORD_ROLE(lib/guards/discord-linked.ts
// offeringRequiresDiscord). 별도 컬럼은 없다. 체크하면 역할 ID가 필수이고(서버도 다시 확인), 체크를 풀면 역할·채널 입력이
// 사라져 서버로 안 가며 서버는 둘 다 비운 것으로 처리한다.
export function OnlineCourseFields({
  defaultOnline,
  defaultRoleId,
  defaultChannelId,
  mono = false,
  paidCount = 0,
}: {
  defaultOnline: boolean;
  defaultRoleId: string;
  defaultChannelId: string;
  mono?: boolean;
  paidCount?: number;
}) {
  const [online, setOnline] = useState(defaultOnline);
  const inputClass = cn(mono && "font-mono text-xs");

  return (
    <div className="col-span-2 flex flex-col gap-2">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="is_online"
          checked={online}
          onChange={(e) => setOnline(e.target.checked)}
          className={checkboxClass}
        />
        온라인(디스코드) 수업
      </label>
      <p className="text-xs text-gray-400">
        {online
          ? "디스코드로 진행하는 강의입니다. 신청·결제 때 학생에게 디스코드 연결을 요구하고, 결제 완료 시 아래 역할을 자동 부여하며 환불·탈퇴 시 회수합니다."
          : "디스코드와 무관한 강의입니다. 학생은 디스코드 연결 없이 신청·결제할 수 있습니다."}
      </p>
      {!online && defaultOnline && paidCount > 0 && (
        <span className="text-xs text-amber-700">
          이미 결제한 {paidCount}명에게 부여된 디스코드 역할은 유지됩니다.
        </span>
      )}
      {online && (
        <>
          <label className="flex flex-col gap-1">
            디스코드 역할 ID(필수)
            <Input
              name="discord_role_id"
              required
              defaultValue={defaultRoleId}
              placeholder="예: 123456789012345678"
              className={inputClass}
            />
            {paidCount > 0 && (
              <span className="text-xs text-amber-700">
                이미 결제한 {paidCount}명은 이전 역할이 유지되고 새 결제자부터 적용됩니다.
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1">
            디스코드 채널 ID(선택 — 학생의 &quot;내 혜택&quot; 화면에서 이 채널로 바로 가는 링크를 보여 줍니다)
            <Input
              name="discord_channel_id"
              defaultValue={defaultChannelId}
              placeholder="예: 123456789012345678"
              className={inputClass}
            />
            <span className="text-xs text-gray-400">
              서버는 시스템 전체에 1개뿐이라(환경변수 DISCORD_GUILD_ID) 채널만 강의마다 다르게 지정합니다.
            </span>
          </label>
        </>
      )}
    </div>
  );
}
