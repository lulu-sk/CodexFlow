// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { ScheduledMessageRepeatEnd } from "@/types/host";

/** 计算结束条件内剩余的计划轮次和最后时刻，设置预览与列表详情共用同一边界。 */
export function getScheduleRepeatPlan(scheduledAt: number, interval: number, sentCount: number, end?: ScheduledMessageRepeatEnd) {
  const remainingCount = end?.mode === "count" ? Math.max(0, end.count - sentCount)
    : end?.mode === "at" ? Math.max(0, Math.floor((end.at - scheduledAt) / interval) + 1) : undefined;
  const lastScheduledAt = remainingCount ? scheduledAt + (remainingCount - 1) * interval : undefined;
  const previewTimes = Array.from({ length: Math.min(2, Math.max(0, (remainingCount ?? 3) - 1)) }, (_, index) => scheduledAt + (index + 1) * interval);
  return { remainingCount, lastScheduledAt, previewTimes };
}
