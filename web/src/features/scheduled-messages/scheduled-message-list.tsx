// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Clock3, Plus, Loader2, Pencil, Repeat2, TriangleAlert, X } from "lucide-react";
import type { ScheduledMessage } from "@/types/host";
import { formatCountdown, formatDuration, formatScheduleTime } from "./schedule-time";
import { useScheduleClock } from "./use-schedule-clock";
import { ExtendScheduleDialog } from "./extend-schedule-dialog";
import { getScheduleRepeatPlan } from "./schedule-repeat-plan";

type Props = {
  tasks: ScheduledMessage[];
  onEdit(task: ScheduledMessage): void;
  onCancel(id: string): Promise<{ ok: boolean }>;
  onExtend(id: string, delayMs: number, baseScheduledAt: number): Promise<{ ok: boolean; error?: string }>;
};

/** 将操作按钮及焦点框限制在紧凑行内，避免通用按钮的尺寸样式覆盖行高。 */
function ScheduleActionButton({ className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} type="button" className={`inline-flex h-5 shrink-0 items-center justify-center rounded text-[10px] leading-none text-[var(--cf-text-secondary)] transition-colors hover:bg-[var(--cf-surface-hover)] hover:text-[var(--cf-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--cf-accent)] disabled:pointer-events-none disabled:opacity-40 ${className}`} />;
}

/** 用单行展示正文摘要、实时倒计时和循环状态，只在查看详情时展开。 */
export function ScheduledMessageList({ tasks, onEdit, onCancel, onExtend }: Props) {
  const { t, i18n } = useTranslation("terminal");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [extending, setExtending] = useState<ScheduledMessage | null>(null);
  const now = useScheduleClock(tasks.some((task) => task.status === "pending"));
  if (!tasks.length && !extending) return null;

  /** 等待取消结果后再更新界面，避免把已开始发送的消息显示为已取消。 */
  async function cancel(id: string): Promise<void> {
    setBusy(id);
    setError(false);
    try { setError(!(await onCancel(id)).ok); } catch { setError(true); }
    finally { setBusy(null); }
  }

  return (
    <div className="max-h-48 shrink-0 overflow-y-auto px-1 pb-0.5" aria-label={t("schedule.list")}>
      {tasks.map((task) => {
        const plan = task.repeatEveryMs ? getScheduleRepeatPlan(task.scheduledAt, task.repeatEveryMs, task.sentCount || 0, task.repeatEnd) : undefined;
        const endSummary = task.repeatEnd?.mode === "count" ? t("schedule.remainingCount", { count: plan?.remainingCount })
          : task.repeatEnd?.mode === "at" ? t("schedule.endAtSummary", { time: formatScheduleTime(task.repeatEnd.at, i18n.language, true) }) : t("schedule.manualEnd");
        return (
        <div key={task.id} className={`rounded-md px-1.5 text-[11px] transition-colors ${expanded === task.id ? "bg-[var(--cf-surface-hover)]" : "hover:bg-[var(--cf-surface-hover)]"}`}>
          <div className="flex h-6 min-w-0 items-center gap-1.5">
            {task.status === "sending" ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : task.status === "failed" ? <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-[var(--cf-red)]" /> : <Clock3 className="h-3.5 w-3.5 shrink-0 text-[var(--cf-accent)]" />}
            <span title={formatScheduleTime(task.scheduledAt, i18n.language)} className={`flex shrink-0 items-center gap-1 rounded px-1 py-0.5 tabular-nums ${task.status === "failed" ? "text-[var(--cf-red)]" : "bg-[var(--cf-accent-light)] text-[var(--cf-accent)]"}`}>
              <span className="text-[10px]">{t(task.repeatEveryMs ? task.sentCount ? "schedule.nextSendShort" : "schedule.firstSendShort" : "schedule.once")}</span>
              {task.status === "pending" && task.scheduledAt > now ? <span role="timer" aria-label={t("schedule.remaining")}>{formatCountdown(task.scheduledAt, now, i18n.language)}</span> : <span role="status">{t(`schedule.${task.status === "pending" ? "due" : task.status}`)}</span>}
            </span>
            <button type="button" aria-expanded={expanded === task.id} aria-label={t("schedule.viewContent")} title={task.text || t("schedule.imagesOnly")} className="flex min-w-0 flex-1 items-center gap-1 rounded text-left text-[var(--cf-text-secondary)] hover:text-[var(--cf-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]" onClick={() => setExpanded(expanded === task.id ? null : task.id)}><span className="truncate">{task.text || t("schedule.imagesOnly")}</span><ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${expanded === task.id ? "rotate-90" : ""}`} /></button>
            {task.repeatEveryMs && <span title={`${t("schedule.repeatSummary", { interval: formatDuration(task.repeatEveryMs, i18n.language) })} · ${endSummary}`} aria-label={t("schedule.repeatSummary", { interval: formatDuration(task.repeatEveryMs, i18n.language) })} className="flex max-w-[40%] shrink items-center gap-1 text-[var(--cf-accent)]"><Repeat2 className="h-3 w-3 shrink-0" /><span className="truncate">{t("schedule.intervalShort", { interval: formatDuration(task.repeatEveryMs, i18n.language) })}{task.repeatEnd && ` · ${endSummary}`}</span></span>}
            <div className="flex shrink-0 items-center gap-0.5">
              <ScheduleActionButton className="gap-0.5 px-1" title={t("schedule.extend")} aria-label={t("schedule.extend")} disabled={(task.status !== "pending" && task.status !== "due") || !!busy} onClick={() => setExtending(task)}><Plus className="h-3 w-3" />{t("schedule.extendShort")}</ScheduleActionButton>
              <ScheduleActionButton className="w-5" title={t("schedule.changeTime")} aria-label={t("schedule.changeTime")} disabled={task.status === "sending" || !!busy} onClick={() => onEdit(task)}><Pencil className="h-3 w-3" /></ScheduleActionButton>
              <ScheduleActionButton className="w-5" title={t(task.status === "failed" ? "schedule.remove" : "schedule.cancel")} aria-label={t(task.status === "failed" ? "schedule.remove" : "schedule.cancel")} disabled={task.status === "sending" || !!busy} onClick={() => void cancel(task.id)}><X className="h-3.5 w-3.5" /></ScheduleActionButton>
            </div>
          </div>
          {task.error && <div className="pb-2 text-[var(--cf-red)]">{t(`schedule.error.${task.error}`)}</div>}
          {expanded === task.id && <div className="border-t border-[var(--cf-border)] px-1 py-2 text-[var(--cf-text-secondary)]">
            <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1"><span>{t(task.repeatEveryMs ? task.sentCount ? "schedule.nextSend" : "schedule.firstSend" : "schedule.singleSend")} · {formatScheduleTime(task.scheduledAt, i18n.language)}</span>{task.repeatEveryMs && <span>{t("schedule.sentCount", { count: task.sentCount || 0 })}</span>}{task.imagePaths.length > 0 && <span>{t("schedule.images", { count: task.imagePaths.length })}</span>}</div>
            {!!task.repeatEveryMs && <div className="mb-1">{endSummary}</div>}
            {plan && task.status !== "failed" && <>
              {plan.previewTimes[0] !== undefined && <div className="mb-1">{t("schedule.followingSend", { time: formatScheduleTime(plan.previewTimes[0], i18n.language) })}</div>}
              {plan.lastScheduledAt !== undefined && <div className="mb-1">{t("schedule.lastSend", { time: formatScheduleTime(plan.lastScheduledAt, i18n.language, true) })}</div>}
            </>}
            <div className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-[var(--cf-text-primary)]">{task.text || t("schedule.imagesOnly")}</div>
          </div>}
        </div>
      ); })}
      {error && <p role="alert" className="text-xs text-[var(--cf-red)]">{t("schedule.cancelFailed")}</p>}
      {extending && <ExtendScheduleDialog key={extending.id} task={extending} onClose={() => setExtending(null)} onExtend={onExtend} />}
    </div>
  );
}
