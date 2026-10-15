// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export const MINUTE_MS = 60_000;
export const MAX_SCHEDULE_DELAY_MS = 30 * 24 * 60 * MINUTE_MS;
export const MAX_REPEAT_END_DELAY_MS = 365 * 24 * 60 * MINUTE_MS;
export const MAX_REPEAT_COUNT = 10_000;
export const DURATION_UNITS = { minute: MINUTE_MS, hour: 60 * MINUTE_MS, day: 24 * 60 * MINUTE_MS };
export type ScheduleDuration = { amount: string; unit: keyof typeof DURATION_UNITS };

/** 将可编辑时长转换为毫秒，空值或非整数交给表单统一报错。 */
export function durationMs(value: ScheduleDuration): number {
  const amount = Number(value.amount);
  return Number.isSafeInteger(amount) && amount > 0 ? amount * DURATION_UNITS[value.unit] : NaN;
}

/** 选择能准确表示间隔的最大单位，便于回显已有循环设置。 */
export function durationFromMs(ms: number): ScheduleDuration {
  const unit = ms % DURATION_UNITS.day === 0 ? "day" : ms % DURATION_UNITS.hour === 0 ? "hour" : "minute";
  return { amount: String(Math.ceil(ms / DURATION_UNITS[unit])), unit };
}

/** 按本地时间生成日期和时分值，避免 UTC 换算改变用户选定日期。 */
export function localDateTimeFields(timestamp: number): { date: string; time: string } {
  const date = new Date(timestamp);
  /** 日期控件的字段统一补齐两位。 */
  const pad = (value: number) => String(value).padStart(2, "0");
  return { date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}` };
}

/** 相对预约保留秒数，明早预约按本地日历固定为九点。 */
export function presetScheduleTime(preset: "tenMinutes" | "thirtyMinutes" | "oneHour" | "tomorrow", now = Date.now()): number {
  if (preset === "tomorrow") {
    const date = new Date(now);
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
    return date.getTime();
  }
  return now + ({ tenMinutes: 10, thirtyMinutes: 30, oneHour: 60 }[preset]) * MINUTE_MS;
}

/** 统一校验未来三十天内的预约，弹窗和追加操作共用边界。 */
export function isScheduleTimeValid(timestamp: number, now: number): boolean {
  return Number.isFinite(timestamp) && timestamp > now && timestamp <= now + MAX_SCHEDULE_DELAY_MS;
}

/** 使用当前语言展示预约时间。 */
export function formatScheduleTime(timestamp: number, language: string, includeYear = false): string {
  return new Intl.DateTimeFormat(language, { ...(includeYear ? { year: "numeric" as const } : {}), month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

/** 显示稳定的时分秒倒计时，跨天时附上本地化的天数，过期不显示负数。 */
export function formatCountdown(timestamp: number, now: number, language: string): string {
  const total = Math.max(0, Math.ceil((timestamp - now) / 1000));
  const days = Math.floor(total / 86_400);
  const clock = [Math.floor(total / 3600) % 24, Math.floor(total / 60) % 60, total % 60].map((part) => String(part).padStart(2, "0")).join(":");
  return days ? `${new Intl.NumberFormat(language, { style: "unit", unit: "day", unitDisplay: "short" }).format(days)} ${clock}` : clock;
}

/** 使用本地化单位显示循环间隔与快捷追加时长。 */
export function formatDuration(ms: number, language: string): string {
  const value = durationFromMs(ms);
  return new Intl.NumberFormat(language, { style: "unit", unit: value.unit, unitDisplay: "short" }).format(Number(value.amount));
}
