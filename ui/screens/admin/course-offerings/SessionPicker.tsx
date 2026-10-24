"use client";

import { useMemo, useState } from "react";
import { Button } from "@/ui/shadcn/button";
import { Input } from "@/ui/shadcn/input";
import { cn } from "@/ui/lib/utils";
import { checkboxClass } from "@/ui/forms/controls";
import { MAX_SESSIONS, dayOfWeek, isValidDate, monthGrid, shiftMonth, weekdayDates, weekdayDatesN } from "@/ui/lib/session-calendar";

// 개설 폼의 달력 입력(ADR-0023). 날짜를 눌러 고르고, 요일 반복은 「채우기(종료일 또는 N회)」로 선택에 더한다.
// 시작 날짜(첫 행)에 「나머지도 같은 시간」 체크박스를 두어 전체 회차 시간을 손쉽게 동기화할 수 있다.
// 저장되는 것은 날짜별 회차 행뿐이다 — 요일·기간 같은 패턴은 저장하지 않고, 개강·종료는 입력이 아니라 첫 회차 시작·마지막 회차 끝으로 계산된다.
// 제출은 숨은 입력 하나(sessions = JSON)로 한다. 입력은 모두 제어 컴포넌트(state)라 React 19가 폼 제출 뒤 입력을 초기화해도 선택이 유지된다.
// 최종 검증은 서버(parseSessionRows)와 DB가 한다 — 여기 검증은 편의일 뿐이다.

const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

type Row = { date: string; start: string; end: string };

function todayMonth(): { year: number; month: number } {
  // 달력 첫 화면의 달만 정한다(저장되는 값 아님). 브라우저 시간대가 달라도 한 달 차이일 뿐이다.
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export function SessionPicker({
  name = "sessions",
  defaultSessions,
  lockedDates = [],
}: {
  name?: string;
  defaultSessions?: Row[];
  lockedDates?: string[];
}) {
  // defaultSessions: 일정 변경에서 현재 활성 회차로 미리 채운다.
  // lockedDates: 이미 시작된 회차의 날짜 목록. 선택 해제나 수정(빼기)이 차단된다.
  const [rows, setRows] = useState<Row[]>(() => (defaultSessions ?? []).map((r) => ({ date: r.date, start: r.start.slice(0, 5), end: r.end.slice(0, 5) })));
  const [view, setView] = useState(() => {
    const first = defaultSessions?.map((r) => r.date).sort()[0];
    return first ? { year: Number(first.slice(0, 4)), month: Number(first.slice(5, 7)) } : todayMonth();
  });
  const [baseStart, setBaseStart] = useState(defaultSessions?.[0]?.start.slice(0, 5) ?? "19:00");
  const [baseEnd, setBaseEnd] = useState(defaultSessions?.[0]?.end.slice(0, 5) ?? "21:00");
  const [fillDays, setFillDays] = useState<boolean[]>([false, false, false, false, false, false, false]);
  const [fillFrom, setFillFrom] = useState("");
  const [fillUntil, setFillUntil] = useState("");
  const [fillCount, setFillCount] = useState<string>("");
  const [syncAllTimes, setSyncAllTimes] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);

  const lockedSet = useMemo(() => new Set(lockedDates), [lockedDates]);
  const selected = useMemo(() => new Set(rows.map((r) => r.date)), [rows]);
  const grid = useMemo(() => monthGrid(view.year, view.month), [view]);
  const sorted = useMemo(() => [...rows].sort((a, b) => a.date.localeCompare(b.date)), [rows]);
  const json = JSON.stringify(sorted);

  // 첫 행이 잠겨있지 않고 2개 이상일 때 나머지 행 중 첫 행과 시각이 다른 행이 있는지 판정
  const hasTimeDeviation = useMemo(() => {
    if (sorted.length < 2) return false;
    const first = sorted[0];
    return sorted.slice(1).some((r) => r.start !== first.start || r.end !== first.end);
  }, [sorted]);

  function addDates(dates: string[]) {
    const fresh = dates.filter((d) => !selected.has(d));
    if (rows.length + fresh.length > MAX_SESSIONS) {
      setMessage(`회차는 최대 ${MAX_SESSIONS}개까지 만들 수 있습니다.`);
      return;
    }
    setMessage(null);
    setRows((prev) => {
      // 만약 syncAllTimes가 켜져 있고 첫 행이 있으면 첫 행 시각을, 아니면 baseStart/baseEnd 적용
      const sortedPrev = [...prev].sort((a, b) => a.date.localeCompare(b.date));
      const firstRow = sortedPrev[0];
      const s = syncAllTimes && firstRow ? firstRow.start : baseStart;
      const e = syncAllTimes && firstRow ? firstRow.end : baseEnd;
      return [...prev, ...fresh.map((date) => ({ date, start: s, end: e }))];
    });
  }

  function toggleDate(date: string) {
    if (lockedSet.has(date)) {
      setMessage(`이미 시작된 회차(${date})는 취소하거나 변경할 수 없습니다.`);
      return;
    }
    if (selected.has(date)) {
      setMessage(null);
      setRows((prev) => prev.filter((r) => r.date !== date));
    } else {
      addDates([date]);
    }
  }

  function fill() {
    const days = fillDays.flatMap((on, i) => (on ? [i] : []));
    if (days.length === 0) return setMessage("채울 요일을 하나 이상 고르세요.");
    if (!isValidDate(fillFrom)) return setMessage("채울 기간의 시작일을 올바르게 입력하세요.");

    const countNum = fillCount.trim() !== "" ? parseInt(fillCount.trim(), 10) : NaN;
    const hasCount = !Number.isNaN(countNum) && countNum > 0;
    const hasUntil = isValidDate(fillUntil);

    if (!hasCount && !hasUntil) {
      return setMessage("종료일 또는 N회(1 이상)를 입력하세요.");
    }

    let dates: string[] = [];
    if (hasCount) {
      dates = weekdayDatesN(fillFrom, countNum, days, hasUntil ? fillUntil : undefined);
    } else {
      dates = weekdayDates(fillFrom, fillUntil, days);
    }

    if (dates.length === 0) return setMessage("조건에 해당하는 날짜가 없습니다(또는 기간이 너무 깁니다).");
    addDates(dates);
  }

  function updateRow(date: string, patch: Partial<Row>) {
    setRows((prev) => {
      const sortedPrev = [...prev].sort((a, b) => a.date.localeCompare(b.date));
      const isFirst = sortedPrev.length > 0 && sortedPrev[0].date === date;

      if (isFirst && syncAllTimes) {
        // 첫 행 시각을 고칠 때 동기화가 켜져 있으면 잠기지 않은 나머지 행도 함께 변경
        return prev.map((r) => {
          if (r.date === date) return { ...r, ...patch };
          if (lockedSet.has(r.date)) return r;
          return { ...r, ...patch };
        });
      }

      // 첫 행이 아니거나 동기화가 꺼져 있으면 해당 행만 변경
      return prev.map((r) => (r.date === date ? { ...r, ...patch } : r));
    });
  }

  function handleSyncToggle(checked: boolean) {
    setSyncAllTimes(checked);
    if (checked && sorted.length > 0) {
      // 체크하면 잠기지 않은 나머지 행의 시작·종료를 첫 행 값으로 통일
      const first = sorted[0];
      setRows((prev) =>
        prev.map((r) => {
          if (r.date === first.date || lockedSet.has(r.date)) return r;
          return { ...r, start: first.start, end: first.end };
        }),
      );
    }
  }

  const summary =
    sorted.length === 0
      ? "아직 고른 날짜가 없습니다."
      : `총 ${sorted.length}회 · ${sorted[0].date}${sorted.length > 1 ? ` ~ ${sorted[sorted.length - 1].date}` : ""} · 개강 = ${sorted[0].date} ${sorted[0].start}`;

  // 첫 행이 잠겨있으면 첫 행의 체크박스를 숨긴다
  const isFirstRowLocked = sorted.length > 0 && lockedSet.has(sorted[0].date);

  return (
    <div className="col-span-2 flex flex-col gap-3 rounded border p-3" data-testid="session-picker">
      <input type="hidden" name={name} value={json} data-testid="session-json" />
      <div className="text-sm font-medium">수업 날짜 (달력에서 눌러 고르세요)</div>
      <p className="text-xs text-gray-400">
        날짜를 누르면 선택/해제됩니다. 회차마다 시각을 따로 정할 수 있고, 개강·종료는 입력이 아니라 첫 회차 시작·마지막 회차 끝으로 계산됩니다.
        같은 날짜·시간대가 겹치는 다른 수업이 있으면 저장이 거부됩니다.
      </p>

      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          기본 시작 시각
          <Input type="time" value={baseStart} onChange={(e) => setBaseStart(e.target.value)} data-testid="base-start" />
        </label>
        <label className="flex flex-col gap-1">
          기본 종료 시각
          <Input type="time" value={baseEnd} onChange={(e) => setBaseEnd(e.target.value)} data-testid="base-end" />
        </label>
        <span className="text-xs text-gray-400">새로 고르는 날짜에 이 시각이 들어갑니다. 이미 고른 날짜는 아래 목록에서 따로 고칩니다.</span>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Button type="button" variant="outline" size="sm" aria-label="이전 달" onClick={() => setView((v) => shiftMonth(v.year, v.month, -1))}>
            ◀
          </Button>
          <span className="text-sm font-medium" data-testid="calendar-title">
            {view.year}년 {view.month}월
          </span>
          <Button type="button" variant="outline" size="sm" aria-label="다음 달" onClick={() => setView((v) => shiftMonth(v.year, v.month, 1))}>
            ▶
          </Button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-xs" role="grid" aria-label="수업 날짜 달력">
          {DAY_LABELS.map((d) => (
            <div key={d} className="py-1 text-gray-500">
              {d}
            </div>
          ))}
          {grid.flat().map((date, i) => {
            if (date === null) return <div key={`pad-${i}`} />;
            const isLocked = lockedSet.has(date);
            return (
              <button
                key={date}
                type="button"
                data-date={date}
                aria-pressed={selected.has(date)}
                aria-label={date}
                disabled={isLocked}
                onClick={() => toggleDate(date)}
                className={cn(
                  "rounded border py-2 text-sm",
                  isLocked
                    ? "cursor-not-allowed border-gray-300 bg-gray-200 text-gray-500"
                    : selected.has(date)
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "bg-white hover:bg-gray-100",
                )}
                title={isLocked ? "이미 시작된 회차(변경 불가)" : undefined}
              >
                {Number(date.slice(8))}
              </button>
            );
          })}
        </div>
      </div>

      <fieldset className="flex flex-col gap-2 rounded border p-2 text-sm">
        <legend className="px-1 text-xs text-gray-500">요일 반복으로 채우기 (고른 날짜에 더해집니다)</legend>
        <div className="flex gap-3 text-xs">
          {DAY_LABELS.map((d, i) => (
            <label key={d} className="flex items-center gap-1">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={fillDays[i]}
                onChange={(e) => setFillDays((prev) => prev.map((v, j) => (j === i ? e.target.checked : v)))}
                data-testid={`fill-day-${i}`}
              />
              {d}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            시작일
            <Input type="date" value={fillFrom} onChange={(e) => setFillFrom(e.target.value)} data-testid="fill-from" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            종료일 (선택)
            <Input type="date" value={fillUntil} onChange={(e) => setFillUntil(e.target.value)} data-testid="fill-until" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            또는 N회
            <Input
              type="number"
              min={1}
              max={MAX_SESSIONS}
              placeholder="예: 3"
              className="w-20"
              value={fillCount}
              onChange={(e) => setFillCount(e.target.value)}
              data-testid="fill-count"
            />
          </label>
          <Button type="button" variant="outline" size="sm" onClick={fill} data-testid="fill-button">
            채우기
          </Button>
        </div>
      </fieldset>

      {message && (
        <p role="alert" className="text-xs text-red-600" data-testid="picker-message">
          {message}
        </p>
      )}

      <p className="text-sm" data-testid="picker-summary">
        {summary}
      </p>
      {sorted.length > 0 && (
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-sm" data-testid="picker-rows">
          {sorted.map((r, index) => {
            const isLocked = lockedSet.has(r.date);
            const isFirst = index === 0;
            return (
              <li key={r.date} className="flex flex-wrap items-center gap-2" data-testid={`session-row-${r.date}`}>
                <span className="w-32">
                  {r.date}({DAY_LABELS[dayOfWeek(r.date)]})
                  {isLocked && <span className="ml-1 text-xs text-gray-500">(시작됨)</span>}
                </span>
                <Input
                  type="time"
                  className="w-32"
                  aria-label={`${r.date} 시작 시각`}
                  value={r.start}
                  disabled={isLocked}
                  onChange={(e) => updateRow(r.date, { start: e.target.value })}
                />
                <span>~</span>
                <Input
                  type="time"
                  className="w-32"
                  aria-label={`${r.date} 종료 시각`}
                  value={r.end}
                  disabled={isLocked}
                  onChange={(e) => updateRow(r.date, { end: e.target.value })}
                />
                {!isLocked ? (
                  <Button type="button" variant="ghost" size="sm" aria-label={`${r.date} 빼기`} onClick={() => toggleDate(r.date)}>
                    ✕
                  </Button>
                ) : (
                  <span className="w-8 text-center text-xs text-gray-400">고정</span>
                )}
                {isFirst && !isFirstRowLocked && sorted.length > 1 && (
                  <label className="ml-2 flex items-center gap-1 text-xs text-gray-600" data-testid="sync-times-label">
                    <input
                      type="checkbox"
                      className={checkboxClass}
                      checked={syncAllTimes}
                      onChange={(e) => handleSyncToggle(e.target.checked)}
                      data-testid="sync-times-checkbox"
                    />
                    나머지도 같은 시간
                  </label>
                )}
                {isFirst && syncAllTimes && hasTimeDeviation && (
                  <span className="ml-2 text-xs text-amber-600" data-testid="sync-deviation-notice">
                    (일부 행이 다름)
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

