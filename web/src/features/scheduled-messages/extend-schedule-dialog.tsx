// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ScheduledMessage } from "@/types/host";
import { ScheduleDurationInput } from "./schedule-duration-input";
import { durationMs, formatCountdown, formatDuration, formatScheduleTime, isScheduleTimeValid, MAX_SCHEDULE_DELAY_MS, MINUTE_MS, type ScheduleDuration } from "./schedule-time";
import { useScheduleClock } from "./use-schedule-clock";

type Props = {
  task: ScheduledMessage;
  onClose(): void;
  onExtend(id: string, delayMs: number, baseScheduledAt: number): Promise<{ ok: boolean; error?: string }>;
};

/** 在原条目之后追加同内容的独立单次预约，始终预览用户选中的基准时刻。 */
export function ExtendScheduleDialog({ task, onClose, onExtend }: Props) {
  const { t, i18n } = useTranslation(["terminal", "common"]);
  const titleId = useId();
  const descriptionId = useId();
  const [duration, setDuration] = useState<ScheduleDuration>({ amount: "10", unit: "minute" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const now = useScheduleClock();
  const delayMs = durationMs(duration);
  const nextTime = task.scheduledAt + delayMs;
  const available = task.status === "pending" || task.status === "due";
  const valid = available && delayMs <= MAX_SCHEDULE_DELAY_MS && isScheduleTimeValid(nextTime, now);

  /** 确认时校验基准时刻，防止原循环已推进后追加到意外的时间。 */
  async function extend(ms: number): Promise<void> {
    if (busy || !available || ms > MAX_SCHEDULE_DELAY_MS || !isScheduleTimeValid(task.scheduledAt + ms, Date.now())) return;
    setBusy(true);
    setError("");
    try {
      const result = await onExtend(task.id, ms, task.scheduledAt);
      if (result.ok) onClose();
      else setError(result.error === "invalid" ? "invalidTime" : "extendFailed");
    } catch { setError("extendFailed"); }
    finally { setBusy(false); }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} className="w-[min(380px,calc(100vw-32px))] p-4" style={{ background: "var(--cf-surface-solid)" }}>
      <DialogTitle id={titleId} className="mb-1 flex items-center gap-2 text-base font-semibold"><Plus className="h-4 w-4 text-[var(--cf-accent)]" />{t("terminal:schedule.extend")}</DialogTitle>
      <DialogDescription id={descriptionId} className="text-xs text-[var(--cf-text-secondary)]">{t("terminal:schedule.extendFrom", { time: formatScheduleTime(task.scheduledAt, i18n.language) })}</DialogDescription>
      <div className="my-3 grid grid-cols-4 gap-1.5">
        {[5, 10, 30, 60].map((minutes) => <Button key={minutes} size="xs" variant="outline" aria-pressed={delayMs === minutes * MINUTE_MS} className={delayMs === minutes * MINUTE_MS ? "border-[var(--cf-accent)] text-[var(--cf-accent)]" : ""} disabled={busy || !available || !isScheduleTimeValid(task.scheduledAt + minutes * MINUTE_MS, now)} onClick={() => { setDuration({ amount: String(minutes), unit: "minute" }); setError(""); }}>+{formatDuration(minutes * MINUTE_MS, i18n.language)}</Button>)}
      </div>
      <ScheduleDurationInput label={t("terminal:schedule.extendDuration")} value={duration} disabled={busy} onChange={(value) => { setDuration(value); setError(""); }} />
      <div className="mt-3 rounded-lg bg-[var(--cf-accent-light)] px-3 py-2 text-xs text-[var(--cf-text-secondary)]">
        <div className="flex items-center justify-between gap-2"><span>{t("terminal:schedule.afterExtend")}</span><span role="timer" aria-label={t("terminal:schedule.remaining")} className="font-semibold tabular-nums text-[var(--cf-accent)]">{valid ? formatCountdown(nextTime, now, i18n.language) : "--:--:--"}</span></div>
        {valid && <div className="mt-1">{formatScheduleTime(nextTime, i18n.language)}</div>}
      </div>
      <p className="mt-2 text-xs text-[var(--cf-text-muted)]">{t("terminal:schedule.extendRepeatHint")}</p>
      {(!valid || error) && <p role="alert" className="mt-2 text-xs text-[var(--cf-red)]">{t(`terminal:schedule.${error || (available ? "invalidTime" : "unavailable")}`)}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} data-cf-dialog-cancel="true" onClick={onClose}>{t("common:cancel")}</Button>
        <Button size="sm" disabled={!valid || busy} data-cf-dialog-primary="true" onClick={() => void extend(delayMs)}>{t(busy ? "terminal:schedule.saving" : "terminal:schedule.confirmExtend")}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
