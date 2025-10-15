// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { TFunction } from "i18next";
import type { CodexRateLimitSnapshot, CodexRateLimitWindow } from "@/types/host";

const MIN_INTERVAL_MS = 60_000;
const DEFAULT_INTERVAL_SECONDS = 30 * 60;

export function computeRefreshInterval(snapshot: CodexRateLimitSnapshot | null | undefined): number {
  if (!snapshot) return MIN_INTERVAL_MS;
  const candidates = [
    snapshot.primary?.resetsInSeconds,
    snapshot.secondary?.resetsInSeconds,
  ]
    .map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null))
    .filter((v): v is number => v != null && v > 0);
  const seconds = candidates.length > 0 ? Math.min(...candidates) : DEFAULT_INTERVAL_SECONDS;
  return Math.max(seconds * 1000, MIN_INTERVAL_MS);
}

export function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "–";
  return `${Math.round(value)}%`;
}

export function formatWindowLabel(
  window: CodexRateLimitWindow | null | undefined,
  t: TFunction,
): string {
  if (!window || window.windowMinutes == null || Number.isNaN(window.windowMinutes)) {
    return t("common:codexUsage.windowUnknown", "不限");
  }
  const minutes = Number(window.windowMinutes);
  if (minutes >= 7 * 24 * 60 - 1) {
    const weeks = Math.ceil(minutes / (7 * 24 * 60));
    return t("common:codexUsage.windowWeekly", { count: weeks });
  }
  if (minutes >= 24 * 60 - 1) {
    const days = Math.ceil(minutes / (24 * 60));
    return t("common:codexUsage.windowDaily", { count: days });
  }
  if (minutes >= 60) {
    const hours = Math.ceil(minutes / 60);
    return t("common:codexUsage.windowHourly", { count: hours });
  }
  return t("common:codexUsage.windowMinutes", { count: Math.max(1, Math.ceil(minutes)) });
}

function resolveLocale(language: string | undefined): string | undefined {
  if (!language) return undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(language);
    return canonical ?? language;
  } catch {
    return language;
  }
}

export function formatResetTime(
  seconds: number | null | undefined,
  t: TFunction,
  language?: string,
): string {
  if (!Number.isFinite(seconds) || seconds == null) {
    return t("common:codexUsage.resetNotProvided", "未提供");
  }
  if (seconds <= 0) return t("common:codexUsage.resetFinished", "已重置");
  const future = new Date(Date.now() + seconds * 1000);
  const locale = resolveLocale(language);
  if (seconds < 24 * 60 * 60) {
    return future.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  return future.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

export function translateRateLimitError(raw: unknown, t: TFunction): string {
  const fallback = t("common:codexUsage.errorFetchFailed", "无法获取速率限制");
  if (raw == null) return fallback;
  const text = String(raw).trim();
  if (!text) return fallback;
  const normalized = text.replace(/^error:\s*/i, "").trim();
  const message = normalized || text;
  if (message.includes("尚未登录 ChatGPT")) {
    return t(
      "common:codexUsage.errorNotLoggedIn",
      "尚未登录 ChatGPT，无法获取速率限制",
    );
  }
  return message || fallback;
}
