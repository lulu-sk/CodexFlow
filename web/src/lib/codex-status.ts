// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { TFunction } from "i18next";
import type { CodexRateLimitSnapshot, CodexRateLimitWindow } from "@/types/host";

const MIN_INTERVAL_MS = 60_000;     // 1 分钟
const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 小时
const DEFAULT_INTERVAL_SECONDS = 5 * 60;  // 无数据时默认 5 分钟
const CLI_EXIT_PATTERNS = [
  /\bCODEX_CLI_EXITED\b/i,
  /codex\s+cli[^a-z0-9]+exited/i,
  /codex\s*cli\s*已退出/i,
];
const NOT_SIGNED_IN_PATTERNS = [
  /尚未登录\s*chatgpt/i,
  /not\s+(signed\s+)?in\s+to\s+chatgpt/i,
];
const CLI_NOT_FOUND_PATTERNS = [
  /未找到.*codex\s*cli/i,
  /codex\s*cli.*not\s+found/i,
];
const CLI_NOT_EXECUTABLE_PATTERNS = [
  /codex\s*cli.*不可执行/i,
  /codex\s*cli.*not\s+executable/i,
];
const REFRESH_TOKEN_FAILED_PATTERNS = [
  /无法刷新.*chatgpt.*登录/i,
  /unable\s+to\s+refresh.*chatgpt.*login/i,
];
const WSL_NOT_SUPPORTED_PATTERNS = [
  /不支持.*wsl.*模式/i,
  /wsl.*mode.*not\s+supported/i,
];
const WSL_PATH_CONVERSION_FAILED_PATTERNS = [
  /无法转换.*codex.*cli.*路径.*wsl/i,
  /unable.*convert.*codex.*cli.*path.*wsl/i,
];
const RATE_LIMIT_FETCH_FAILED_PATTERNS = [
  /请求速率限制失败/i,
  /rate\s+limit\s+request\s+failed/i,
];

export function computeRefreshInterval(snapshot: CodexRateLimitSnapshot | null | undefined): number {
  if (!snapshot) return MIN_INTERVAL_MS;
  
  // 仅从有消耗的窗口中选取最小重置时间
  const candidates: number[] = [];
  if (snapshot.primary?.usedPercent && snapshot.primary.usedPercent > 0 && snapshot.primary.resetAfterSeconds) {
    candidates.push(snapshot.primary.resetAfterSeconds);
  }
  if (snapshot.secondary?.usedPercent && snapshot.secondary.usedPercent > 0 && snapshot.secondary.resetAfterSeconds) {
    candidates.push(snapshot.secondary.resetAfterSeconds);
  }
  
  let seconds = candidates.length > 0 ? Math.min(...candidates) : DEFAULT_INTERVAL_SECONDS;
  
  // 兜底：防止 Infinity 或异常值
  if (!Number.isFinite(seconds) || seconds <= 0) {
    seconds = DEFAULT_INTERVAL_SECONDS;
  }
  
  // 夹在 [1min, 6h] 之间
  let intervalMs = Math.max(MIN_INTERVAL_MS, Math.min(seconds * 1000, MAX_INTERVAL_MS));
  
  // 加 5-10% jitter，避免多实例同时打点
  const jitter = 0.05 + Math.random() * 0.05;  // 5-10%
  intervalMs = Math.floor(intervalMs * (1 + jitter));
  
  return intervalMs;
}

export function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "–";
  return `${Math.round(value)}%`;
}

export function formatWindowLabel(
  window: CodexRateLimitWindow | null | undefined,
  t: TFunction,
): string {
  if (!window || window.limitWindowSeconds == null || Number.isNaN(window.limitWindowSeconds)) {
    return t("common:codexUsage.windowUnknown", "不限");
  }
  // UI 层转换：秒 → 分钟
  const minutes = Number(window.limitWindowSeconds) / 60;
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

export function resolveDominantUsageWindow(
  snapshot: CodexRateLimitSnapshot | null | undefined,
): CodexRateLimitWindow | null {
  if (!snapshot) return null;
  const candidates: Array<{ window: CodexRateLimitWindow; priority: number }> = [];
  if (snapshot.primary) candidates.push({ window: snapshot.primary, priority: 0 });
  if (snapshot.secondary) candidates.push({ window: snapshot.secondary, priority: 1 });
  if (candidates.length === 0) return null;
  return candidates
    .reduce((best, current) => {
      if (!best) return current;
      const bestPercent =
        typeof best.window.usedPercent === "number" && Number.isFinite(best.window.usedPercent)
          ? best.window.usedPercent
          : -Infinity;
      const currentPercent =
        typeof current.window.usedPercent === "number" &&
        Number.isFinite(current.window.usedPercent)
          ? current.window.usedPercent
          : -Infinity;
      if (currentPercent > bestPercent) return current;
      if (currentPercent === bestPercent && current.priority < best.priority) return current;
      return best;
    })
    .window;
}

export function formatUsageSummaryLabel(
  window: CodexRateLimitWindow | null | undefined,
  percent: number | null | undefined,
  t: TFunction,
): string {
  const percentLabel = formatPercent(percent);
  const limitWindowSeconds = window?.limitWindowSeconds;
  const hasWindow = typeof limitWindowSeconds === "number" && Number.isFinite(limitWindowSeconds);
  if (hasWindow) {
    const windowLabel = formatWindowLabel(window, t);
    return t("common:codexUsage.summaryWithWindow", {
      percent: percentLabel,
      window: windowLabel,
    });
  }
  return t("common:codexUsage.summary", {
    percent: percentLabel,
  });
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

function normalizeCodexError(raw: unknown): string {
  if (raw == null) return "";
  if (raw instanceof Error) {
    const msg = raw.message?.trim();
    if (msg) return msg;
  }
  const text = String(raw).trim();
  const normalized = text.replace(/^error:\s*/i, "").trim();
  return normalized || text;
}

export function translateCodexBridgeError(
  raw: unknown,
  t: TFunction,
  options?: { fallbackKey?: string; fallbackDefault?: string },
): string {
  const fallbackKey = options?.fallbackKey ?? "common:codexUsage.errorFetchFailed";
  const fallbackDefault = options?.fallbackDefault ?? "无法获取速率限制";
  const fallback = t(fallbackKey, fallbackDefault);
  const message = normalizeCodexError(raw);
  if (!message) return fallback;
  
  // CLI 退出错误
  if (CLI_EXIT_PATTERNS.some((pattern) => pattern.test(message))) {
    return t("common:codexErrors.cliExited", "错误，请尝试更换刷新WSL发行版并保存");
  }
  
  // 未登录错误
  if (NOT_SIGNED_IN_PATTERNS.some((pattern) => pattern.test(message))) {
    return t("common:codexUsage.errorNotLoggedIn", "尚未登录 ChatGPT，无法获取速率限制");
  }
  
  // CLI 未找到
  if (CLI_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(message))) {
    return t("common:codexErrors.cliNotFound", "未找到 Codex CLI。请尝试：\n1. npm install -g @openai/codex\n2. 或安装 Cursor/Windsurf 插件\n3. 或设置 CODEXFLOW_CODEX_BIN 环境变量");
  }
  
  // CLI 不可执行
  if (CLI_NOT_EXECUTABLE_PATTERNS.some((pattern) => pattern.test(message))) {
    return t("common:codexErrors.cliNotExecutable", "codex CLI 不可执行");
  }
  
  // 刷新 Token 失败
  if (REFRESH_TOKEN_FAILED_PATTERNS.some((pattern) => pattern.test(message))) {
    return t("common:codexErrors.refreshTokenFailed", "无法刷新 ChatGPT 登录状态");
  }
  
  // WSL 不支持
  if (WSL_NOT_SUPPORTED_PATTERNS.some((pattern) => pattern.test(message))) {
    return t("common:codexErrors.wslNotSupported", "当前环境不支持 WSL 模式");
  }
  
  // WSL 路径转换失败
  if (WSL_PATH_CONVERSION_FAILED_PATTERNS.some((pattern) => pattern.test(message))) {
    return t("common:codexErrors.wslPathConversionFailed", "无法转换 codex CLI 路径以供 WSL 使用");
  }
  
  // 速率限制获取失败（通用）
  if (RATE_LIMIT_FETCH_FAILED_PATTERNS.some((pattern) => pattern.test(message))) {
    return fallback;
  }
  
  return message || fallback;
}

export function translateRateLimitError(raw: unknown, t: TFunction): string {
  return translateCodexBridgeError(raw, t, {
    fallbackKey: "common:codexUsage.errorFetchFailed",
    fallbackDefault: "无法获取速率限制",
  });
}

// 触发 Codex 用量刷新（渲染进程全局事件）
// 说明：终端任务完成后会派发本事件；顶部栏用量组件监听并在 1 分钟冷却后触发刷新。
export const CODEX_RATE_REFRESH_EVENT = "codex:rate-refresh-request";
export type CodexRateRefreshDetail = { source?: string };
export function emitCodexRateRefresh(source?: string): void {
  try {
    const detail: CodexRateRefreshDetail | undefined = source ? { source } : undefined;
    window.dispatchEvent(new CustomEvent<CodexRateRefreshDetail>(CODEX_RATE_REFRESH_EVENT as any, { detail } as any));
  } catch {}
}