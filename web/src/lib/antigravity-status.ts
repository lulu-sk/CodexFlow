// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { TFunction } from "i18next";

export const ANTIGRAVITY_USAGE_REFRESH_EVENT = "antigravity:usage-refresh-request";
export type AntigravityUsageRefreshDetail = { source?: string };

const ANTIGRAVITY_CLI_NOT_FOUND_PATTERNS = [
  /ANTIGRAVITY_CLI_NOT_FOUND/i,
  /\bagy\b.*not\s+found/i,
  /未找到.*agy/i,
];

const ANTIGRAVITY_LOCAL_SERVICE_PATTERNS = [
  /ANTIGRAVITY_LOCAL_SERVICE_NOT_FOUND/i,
  /local\s+service/i,
  /language[_\s-]?server/i,
  /quota\s+server/i,
];

/**
 * 归一化主进程返回的错误文本。
 */
function normalizeUsageErrorText(raw: unknown): string {
  if (raw == null) return "";
  const text = raw instanceof Error ? String(raw.message || "") : String(raw);
  return text.replace(/^error:\s*/i, "").trim();
}

/**
 * 将 Antigravity 用量错误翻译为“标题 + 提示”两行文案。
 */
export function formatAntigravityUsageErrorText(raw: unknown, t: TFunction): string {
  const message = normalizeUsageErrorText(raw);

  const defaultTitle = t("common:antigravityUsage.errors.default.title", "无法获取 Antigravity 用量");
  const defaultHint = t("common:antigravityUsage.errors.default.hint", "请确认 Antigravity 或 AGY 已登录后重试");

  if (!message) return `${defaultTitle}\n${defaultHint}`;

  if (ANTIGRAVITY_CLI_NOT_FOUND_PATTERNS.some((p) => p.test(message))) {
    const title = t("common:antigravityUsage.errors.cliNotFound.title", "未检测到 AGY CLI");
    const hint = t("common:antigravityUsage.errors.cliNotFound.hint", "请安装 Antigravity CLI，或设置 ANTIGRAVITY_CLI_PATH 后重试");
    return `${title}\n${hint}`;
  }

  if (ANTIGRAVITY_LOCAL_SERVICE_PATTERNS.some((p) => p.test(message))) {
    const title = t("common:antigravityUsage.errors.localService.title", "未检测到 Antigravity 本地服务");
    const hint = t("common:antigravityUsage.errors.localService.hint", "请打开 Antigravity / AGY，或稍后再次刷新");
    return `${title}\n${hint}`;
  }

  return `${defaultTitle}\n${defaultHint}`;
}

/**
 * 触发一次 Antigravity 用量刷新请求。
 */
export function emitAntigravityUsageRefresh(source?: string): void {
  try {
    const detail: AntigravityUsageRefreshDetail | undefined = source ? { source } : undefined;
    window.dispatchEvent(new CustomEvent<AntigravityUsageRefreshDetail>(ANTIGRAVITY_USAGE_REFRESH_EVENT as any, { detail } as any));
  } catch {}
}
