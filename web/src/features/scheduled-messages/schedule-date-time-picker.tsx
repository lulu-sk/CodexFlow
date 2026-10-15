// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { localDateTimeFields, MAX_SCHEDULE_DELAY_MS } from "./schedule-time";

type Fields = { date: string; time: string };
type Props = { value: Fields; now: number; disabled?: boolean; maxTimestamp?: number; labelPrefix?: string; onChange(value: Fields): void };

/** 使用可点击月历与小时、分钟下拉框设置本地时间，不依赖系统日期输入框。 */
export function ScheduleDateTimePicker({ value, now, disabled, maxTimestamp = now + MAX_SCHEDULE_DELAY_MS, labelPrefix = "", onChange }: Props) {
  const { t, i18n } = useTranslation("terminal");
  const calendarId = useId();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => value.date.slice(0, 7));
  const today = localDateTimeFields(now).date;
  const lastDay = localDateTimeFields(maxTimestamp).date;
  const first = new Date(`${month}-01T12:00:00`);
  const dayCount = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const [hour, minute] = value.time.split(":");
  const selectClass = "h-9 w-full cursor-pointer appearance-none rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] pl-3 pr-6 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--cf-accent)]/40 disabled:opacity-40";

  /** 在可预约月份之间切换，保留用户已经选中的日期。 */
  function moveMonth(offset: number): void {
    setMonth(localDateTimeFields(new Date(first.getFullYear(), first.getMonth() + offset, 1, 12).getTime()).date.slice(0, 7));
  }

  /** 选择日期后收起月历，保留已设置的小时和分钟。 */
  function chooseDate(date: string): void {
    onChange({ ...value, date });
    setOpen(false);
  }

  return <div>
    <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.85fr)] gap-2">
      <Button size="sm" variant="outline" className="h-9 min-w-0 justify-between gap-1 px-2" aria-label={`${labelPrefix}${t("schedule.date")}`} aria-expanded={open} aria-controls={calendarId} disabled={disabled} onClick={() => { setMonth(value.date.slice(0, 7)); setOpen(!open); }}>
        <CalendarDays className="h-3.5 w-3.5 shrink-0" /><span className="truncate tabular-nums">{value.date}</span><ChevronDown className="h-3 w-3 shrink-0" />
      </Button>
      <div className="relative">
        <Clock3 className="pointer-events-none absolute left-2 top-3 h-3 w-3 text-[var(--cf-text-muted)]" />
        <select aria-label={`${labelPrefix}${t("schedule.hour")}`} className={`${selectClass} pl-7`} value={hour} disabled={disabled} onChange={(event) => onChange({ ...value, time: `${event.target.value}:${minute}` })}>
          {Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0")).map((item) => <option key={item} value={item}>{t("schedule.hourValue", { value: item })}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-3 h-3 w-3" />
      </div>
      <div className="relative">
        <select aria-label={`${labelPrefix}${t("schedule.minute")}`} className={selectClass} value={minute} disabled={disabled} onChange={(event) => onChange({ ...value, time: `${hour}:${event.target.value}` })}>
          {Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0")).map((item) => <option key={item} value={item}>{t("schedule.minuteValue", { value: item })}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-3 h-3 w-3" />
      </div>
    </div>
    {open && <div id={calendarId} role="group" aria-label={`${labelPrefix}${t("schedule.calendar")}`} className="mt-2 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] p-2">
      <div className="mb-1 flex items-center justify-between">
        <Button size="icon-sm" variant="ghost" aria-label={t("schedule.previousMonth")} disabled={disabled || month <= today.slice(0, 7)} onClick={() => moveMonth(-1)}><ChevronLeft className="h-4 w-4" /></Button>
        <span aria-live="polite" className="text-sm font-medium">{new Intl.DateTimeFormat(i18n.language, { year: "numeric", month: "long" }).format(first)}</span>
        <Button size="icon-sm" variant="ghost" aria-label={t("schedule.nextMonth")} disabled={disabled || month >= lastDay.slice(0, 7)} onClick={() => moveMonth(1)}><ChevronRight className="h-4 w-4" /></Button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-xs">
        {Array.from({ length: 7 }, (_, day) => <span key={`weekday-${day}`} className="py-1 text-[var(--cf-text-muted)]">{new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(new Date(2024, 0, 7 + day))}</span>)}
        {Array.from({ length: first.getDay() }, (_, index) => <span key={`empty-${index}`} />)}
        {Array.from({ length: dayCount }, (_, index) => {
          const date = `${month}-${String(index + 1).padStart(2, "0")}`;
          return <button key={date} type="button" aria-label={date} aria-pressed={date === value.date} aria-current={date === today ? "date" : undefined} disabled={disabled || date < today || date > lastDay} onClick={() => chooseDate(date)} className={`h-8 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)] disabled:opacity-25 ${date === value.date ? "bg-[var(--cf-accent)] text-white" : "hover:bg-[var(--cf-accent-light)]"}`}>{index + 1}</button>;
        })}
      </div>
    </div>}
  </div>;
}
