// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarClock, ChevronDown, Clock3, Info, Paperclip, Repeat2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ScheduledMessageInput, ScheduledMessageRepeatEnd } from "@/types/host";
import { ScheduleDurationInput } from "./schedule-duration-input";
import { ScheduleDateTimePicker } from "./schedule-date-time-picker";
import { durationFromMs, durationMs, formatCountdown, formatScheduleTime, isScheduleTimeValid, localDateTimeFields, MAX_REPEAT_COUNT, MAX_REPEAT_END_DELAY_MS, MAX_SCHEDULE_DELAY_MS, MINUTE_MS, presetScheduleTime, type ScheduleDuration } from "./schedule-time";
import { getScheduleRepeatPlan } from "./schedule-repeat-plan";
import { useScheduleClock } from "./use-schedule-clock";

type Props = {
  input: ScheduledMessageInput & { sentCount?: number };
  editing: boolean;
  onClose(): void;
  onSubmit(input: ScheduledMessageInput): Promise<{ ok: boolean; error?: string }>;
};

/** 紧凑设置发送时刻与循环间隔，实时预览倒计时，失败时保留当前选择。 */
export function ScheduleMessageDialog({ input, editing, onClose, onSubmit }: Props) {
  const { t, i18n } = useTranslation(["terminal", "common"]);
  const titleId = useId();
  const descriptionId = useId();
  const [scheduledAt, setScheduledAt] = useState(() => editing && input.scheduledAt > Date.now() ? input.scheduledAt : presetScheduleTime("tenMinutes"));
  const [fields, setFields] = useState(() => localDateTimeFields(scheduledAt));
  const [mode, setMode] = useState<"relative" | "absolute">(editing ? "absolute" : "relative");
  const [delay, setDelay] = useState<ScheduleDuration>({ amount: "10", unit: "minute" });
  const [preset, setPreset] = useState(editing ? "" : "tenMinutes");
  const [repeat, setRepeat] = useState(!!input.repeatEveryMs);
  const [customFirst, setCustomFirst] = useState(editing);
  const [interval, setInterval] = useState(() => durationFromMs(input.repeatEveryMs || 30 * MINUTE_MS));
  const [endMode, setEndMode] = useState<"manual" | "count" | "at">(input.repeatEnd?.mode || (input.repeatEveryMs ? "manual" : "count"));
  const [endCount, setEndCount] = useState(String(input.repeatEnd?.mode === "count" ? input.repeatEnd.count : (input.sentCount || 0) + 5));
  const [endFields, setEndFields] = useState(() => localDateTimeFields(input.repeatEnd?.mode === "at" ? input.repeatEnd.at : Math.ceil((scheduledAt + 4 * (input.repeatEveryMs || 30 * MINUTE_MS)) / MINUTE_MS) * MINUTE_MS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const now = useScheduleClock();
  const validTime = isScheduleTimeValid(scheduledAt, now);
  const repeatEveryMs = repeat ? durationMs(interval) : undefined;
  const validRepeat = !repeat || (Number.isFinite(repeatEveryMs) && repeatEveryMs! >= MINUTE_MS && repeatEveryMs! <= MAX_SCHEDULE_DELAY_MS);
  const sentCount = input.sentCount || 0;
  const endAt = new Date(`${endFields.date}T${endFields.time}:00`).getTime();
  const validEnd = !repeat || endMode === "manual" || (endMode === "count"
    ? Number.isSafeInteger(Number(endCount)) && Number(endCount) > sentCount && Number(endCount) <= MAX_REPEAT_COUNT
    : Number.isFinite(endAt) && endAt >= scheduledAt && endAt <= now + MAX_REPEAT_END_DELAY_MS);
  const repeatEnd: ScheduledMessageRepeatEnd | undefined = !repeat || endMode === "manual" ? undefined : endMode === "count" ? { mode: "count", count: Number(endCount) } : { mode: "at", at: endAt };
  const plan = repeat && validRepeat && validTime && validEnd ? getScheduleRepeatPlan(scheduledAt, repeatEveryMs!, sentCount, repeatEnd) : undefined;
  const phaseKey = repeat ? input.sentCount ? "nextSend" : "firstSend" : "singleSend";

  /** 切换发送方式时，循环默认在一个间隔后首次发送，避免隐含第二套计时规则。 */
  function changeRepeat(value: boolean): void {
    setRepeat(value);
    if (value && !customFirst) changeDelay(interval);
  }

  /** 默认首发与间隔同步，自定义首发只影响第一轮的等待时间。 */
  function changeInterval(value: ScheduleDuration): void {
    setInterval(value);
    if (!customFirst) changeDelay(value);
  }

  /** 修改相对时长时重新锚定当前时间；停留期间保持目标不变，让预览真实倒数。 */
  function changeDelay(value: ScheduleDuration): void {
    const next = Date.now() + durationMs(value);
    setDelay(value);
    setScheduledAt(next);
    if (Number.isFinite(next)) setFields(localDateTimeFields(next));
    setPreset("");
    setError("");
  }

  /** 快捷选择同时更新日期、时长与模式，避免两个入口的显示不一致。 */
  function choosePreset(choice: "tenMinutes" | "thirtyMinutes" | "oneHour" | "tomorrow"): void {
    const current = Date.now();
    const next = presetScheduleTime(choice, current);
    setScheduledAt(next);
    setFields(localDateTimeFields(next));
    setDelay(durationFromMs(next - current));
    setMode(choice === "tomorrow" ? "absolute" : "relative");
    setPreset(choice);
    setError("");
  }

  /** 同步月历与时分选择，并重新计算绝对发送时刻。 */
  function changeFields(next: typeof fields): void {
    setFields(next);
    setScheduledAt(new Date(`${next.date}T${next.time}:00`).getTime());
    setPreset("");
    setError("");
  }

  /** 首次启用截止时间时，将过早的默认值调整到当前发送计划之后。 */
  function changeEndMode(value: typeof endMode): void {
    if (value === "at" && Number.isFinite(scheduledAt) && (!Number.isFinite(endAt) || endAt < scheduledAt))
      setEndFields(localDateTimeFields(Math.ceil((scheduledAt + 4 * (validRepeat ? repeatEveryMs! : 30 * MINUTE_MS)) / MINUTE_MS) * MINUTE_MS));
    setEndMode(value);
    setError("");
  }

  /** 提交前使用真实时钟再次校验，防止后台停留或休眠后提交过期预约。 */
  async function submit(): Promise<void> {
    if (busy || !validRepeat || !validEnd) return;
    if (!isScheduleTimeValid(scheduledAt, Date.now())) { setError("invalidTime"); return; }
    setBusy(true);
    setError("");
    try {
      const payload = { ...input, scheduledAt, repeatEveryMs };
      if (repeatEnd) payload.repeatEnd = repeatEnd;
      else delete payload.repeatEnd;
      const result = await onSubmit(payload);
      if (result.ok) onClose();
      else setError(result.error === "limit" ? "limit" : result.error === "unavailable" ? "unavailable" : result.error === "invalidEnd" ? "invalidEnd" : "saveFailed");
    } catch { setError("saveFailed"); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} className="max-h-[calc(100vh-40px)] w-[min(460px,calc(100vw-32px))] overflow-y-auto p-4" style={{ background: "var(--cf-surface-solid)" }}>
        <div className="mb-3 flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--cf-accent-light)] text-[var(--cf-accent)]"><CalendarClock className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <DialogTitle id={titleId} className="mb-0.5 text-base font-semibold">{t(editing ? "terminal:schedule.editTitle" : "terminal:schedule.title")}</DialogTitle>
            <DialogDescription id={descriptionId} className="truncate text-xs text-[var(--cf-text-secondary)]" title={input.tabName}>{t("terminal:schedule.destination", { name: input.tabName })}</DialogDescription>
          </div>
          <Button size="icon-sm" variant="ghost" aria-label={t("common:cancel")} disabled={busy} onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>

        <details className="group mb-3 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-3 py-1.5 text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden" title={t("terminal:schedule.viewContent")}>
            <span className="shrink-0 text-[var(--cf-text-muted)]">{t("terminal:schedule.preview")}</span>
            <span className="min-w-0 flex-1 truncate text-[var(--cf-text-secondary)]">{input.text || t("terminal:schedule.imagesOnly")}</span>
            {input.imagePaths.length > 0 && <span className="flex shrink-0 items-center gap-1 text-[var(--cf-text-muted)]" title={t("terminal:schedule.images", { count: input.imagePaths.length })}><Paperclip className="h-3 w-3" />{input.imagePaths.length}</span>}
            <ChevronDown className="h-3 w-3 shrink-0 text-[var(--cf-text-muted)] transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words border-t border-[var(--cf-border)] pt-2 text-[var(--cf-text-primary)]">{input.text || t("terminal:schedule.imagesOnly")}</div>
        </details>

        <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-[var(--cf-surface-hover)] p-1" role="group" aria-label={t("terminal:schedule.sendMode")}>
          {[false, true].map((value) => <Button key={String(value)} size="sm" variant="ghost" aria-pressed={repeat === value} disabled={busy} className={`gap-2 ${repeat === value ? "bg-[var(--cf-surface-solid)] text-[var(--cf-accent)] shadow-sm" : "text-[var(--cf-text-secondary)]"}`} onClick={() => changeRepeat(value)}>{value ? <Repeat2 className="h-4 w-4" /> : <CalendarClock className="h-4 w-4" />}{t(value ? "terminal:schedule.repeat" : "terminal:schedule.singleMode")}</Button>)}
        </div>
        {repeat && <div className="mb-3 space-y-2">
          <div className="flex items-center gap-3"><span className="shrink-0 text-xs text-[var(--cf-text-secondary)]">{t("terminal:schedule.repeatEvery")}</span><div className="min-w-0 flex-1"><ScheduleDurationInput label={t("terminal:schedule.repeatInterval")} value={interval} disabled={busy} onChange={changeInterval} /></div></div>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--cf-text-secondary)]"><input type="checkbox" checked={customFirst} disabled={busy} className="accent-[var(--cf-accent)]" onChange={(event) => { setCustomFirst(event.target.checked); if (!event.target.checked) changeDelay(interval); }} />{t(input.sentCount ? "terminal:schedule.customNext" : "terminal:schedule.customFirst")}</label>
          {!customFirst && <p className="text-[11px] text-[var(--cf-text-muted)]">{t(input.sentCount ? "terminal:schedule.nextAfterInterval" : "terminal:schedule.firstAfterInterval")}</p>}
        </div>}
        {(!repeat || customFirst) && <>
        {repeat && <div className="mb-1.5 text-xs font-medium text-[var(--cf-text-secondary)]">{t(`terminal:schedule.${phaseKey}`)}</div>}
        <div className="mb-2 grid grid-cols-2 gap-1" role="group" aria-label={t("terminal:schedule.timeMode")}>
          {(["relative", "absolute"] as const).map((choice) => <Button key={choice} size="xs" variant="ghost" disabled={busy} aria-pressed={mode === choice} className={mode === choice ? "bg-[var(--cf-surface-solid)] text-[var(--cf-text-primary)] shadow-sm" : ""} onClick={() => { if (choice === "relative" && mode !== choice) changeDelay(durationFromMs(Math.max(MINUTE_MS, Number.isFinite(scheduledAt) ? scheduledAt - Date.now() : 10 * MINUTE_MS))); setMode(choice); }}>{t(`terminal:schedule.${choice}`)}</Button>)}
        </div>

        {mode === "relative" ? (
          <ScheduleDurationInput label={t("terminal:schedule.delay")} value={delay} disabled={busy} onChange={changeDelay} />
        ) : (
          <ScheduleDateTimePicker value={fields} now={now} disabled={busy} onChange={changeFields} />
        )}
        <div className="mt-2 grid grid-cols-2 gap-1.5 min-[420px]:grid-cols-4">
          {(["tenMinutes", "thirtyMinutes", "oneHour", "tomorrow"] as const).map((choice) => (
            <Button key={choice} size="xs" variant="outline" disabled={busy} aria-pressed={preset === choice} className={`min-w-0 px-1 text-[11px] ${preset === choice ? "border-[var(--cf-accent)] bg-[var(--cf-accent-light)] text-[var(--cf-accent)]" : ""}`} onClick={() => choosePreset(choice)}>{t(`terminal:schedule.${choice}`)}</Button>
          ))}
        </div>
        </>}

        {repeat && <div className="mt-3 space-y-2 border-t border-[var(--cf-border)] pt-3">
          <label className="flex items-center gap-3 text-xs text-[var(--cf-text-secondary)]"><span className="shrink-0">{t("terminal:schedule.endCondition")}</span>
            <select aria-label={t("terminal:schedule.endCondition")} value={endMode} disabled={busy} onChange={(event) => changeEndMode(event.target.value as typeof endMode)} className="h-8 min-w-0 flex-1 cursor-pointer rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--cf-accent)]/40">
              {(["count", "at", "manual"] as const).map((value) => <option key={value} value={value}>{t(`terminal:schedule.endMode.${value}`)}</option>)}
            </select>
          </label>
          {endMode === "count" && <>
            <label className="flex items-center gap-3 text-xs text-[var(--cf-text-secondary)]"><span>{t("terminal:schedule.totalCount")}</span><input type="number" aria-label={t("terminal:schedule.totalCount")} min={sentCount + 1} max={MAX_REPEAT_COUNT} step="1" value={endCount} disabled={busy} onChange={(event) => { setEndCount(event.target.value); setError(""); }} className="h-8 w-20 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--cf-accent)]/40" /></label>
            <p className="text-[11px] text-[var(--cf-text-muted)]">{validEnd ? t("terminal:schedule.countProgress", { sent: sentCount, remaining: Number(endCount) - sentCount }) : t("terminal:schedule.countHint")}</p>
          </>}
          {endMode === "at" && <>
            <ScheduleDateTimePicker value={endFields} now={now} maxTimestamp={now + MAX_REPEAT_END_DELAY_MS} labelPrefix={t("terminal:schedule.endLabelPrefix")} disabled={busy} onChange={(value) => { setEndFields(value); setError(""); }} />
            <p className="text-[11px] text-[var(--cf-text-muted)]">{t("terminal:schedule.endAtHint")}</p>
          </>}
        </div>}

        <div className="my-3 rounded-xl bg-[var(--cf-accent-light)] px-3 py-2.5">
          <div className="flex items-center gap-2">
          <Clock3 className="h-4 w-4 shrink-0 text-[var(--cf-accent)]" />
          <div className="min-w-0 flex-1 text-xs text-[var(--cf-text-secondary)]" title={t("terminal:schedule.timezone", { zone: Intl.DateTimeFormat().resolvedOptions().timeZone })}><div className="mb-0.5 font-medium text-[var(--cf-text-primary)]">{t(`terminal:schedule.${phaseKey}`)}</div>{validTime ? formatScheduleTime(scheduledAt, i18n.language) : t(validRepeat ? "terminal:schedule.invalidTime" : "terminal:schedule.invalidInterval")}</div>
          <div className="shrink-0 text-right">
            <span role="timer" aria-label={t("terminal:schedule.remaining")} className="text-xl font-semibold tabular-nums tracking-tight text-[var(--cf-accent)]">{validTime ? formatCountdown(scheduledAt, now, i18n.language) : "--:--:--"}</span>
            <div className="text-[10px] leading-3 text-[var(--cf-text-secondary)]">{t("terminal:schedule.untilSend")}</div>
          </div>
          </div>
          {plan && <div className="mt-2 space-y-1 border-t border-[var(--cf-accent)]/15 pt-2 text-[11px] text-[var(--cf-text-secondary)]">
            {plan.previewTimes.map((time, index) => <div key={time} className="flex justify-between gap-2"><span>{t("terminal:schedule.occurrence", { count: sentCount + index + 2 })}</span><span className="tabular-nums">{formatScheduleTime(time, i18n.language)}</span></div>)}
            {plan.lastScheduledAt ? <div>{t("terminal:schedule.lastSend", { time: formatScheduleTime(plan.lastScheduledAt, i18n.language, true) })}</div> : <div>{t("terminal:schedule.manualEnd")}</div>}
          </div>}
        </div>
        {repeat && <p className="text-[11px] text-[var(--cf-text-muted)]">{t("terminal:schedule.repeatHint")}</p>}
        {!validTime && validRepeat && <p role="alert" className="mt-2 text-xs text-[var(--cf-red)]">{t("terminal:schedule.invalidTime")}</p>}
        {!validRepeat && <p role="alert" className="mt-2 text-xs text-[var(--cf-red)]">{t("terminal:schedule.invalidInterval")}</p>}
        {!validEnd && <p role="alert" className="mt-2 text-xs text-[var(--cf-red)]">{t(endMode === "count" ? "terminal:schedule.invalidEndCount" : "terminal:schedule.invalidEndTime", { min: sentCount + 1 })}</p>}
        {error && <p role="alert" className="mt-2 text-xs text-[var(--cf-red)]">{t(`terminal:schedule.${error}`)}</p>}

        <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--cf-border)] pt-3">
          <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-[var(--cf-text-muted)]" title={t("terminal:schedule.keepOpen")}><Info className="h-3 w-3 shrink-0" /><span>{t("terminal:schedule.keepOpenShort")}</span></div>
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy} data-cf-dialog-cancel="true" onClick={onClose}>{t("common:cancel")}</Button>
            <Button size="sm" disabled={!validTime || !validRepeat || !validEnd || busy} data-cf-dialog-primary="true" onClick={() => void submit()}><CalendarClock className="mr-2 h-3.5 w-3.5" />{t(busy ? "terminal:schedule.saving" : editing ? "terminal:schedule.save" : "terminal:schedule.confirm")}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
