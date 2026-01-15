// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { TFunction } from "i18next";

// 触发 Claude 用量刷新（渲染进程全局事件）
// 说明：顶部栏用量组件监听并在冷却后触发刷新。
export const CLAUDE_USAGE_REFRESH_EVENT = "claude:usage-refresh-request";
export type ClaudeUsageRefreshDetail = { source?: string };

const TMUX_NOT_FOUND_PATTERNS = [
  /\btmux_not_found\b/i,
  /\btmux\b.*not\s+found/i,
  /未找到.*tmux/i,
];

const CLAUDE_CLI_NOT_FOUND_PATTERNS = [
  /\bclaude_cli_not_found\b/i,
  /\bclaude\b.*not\s+found/i,
  /未找到\s*claude/i,
];

const CLAUDE_AUTH_REQUIRED_PATTERNS = [
  /\bauth_required_or_cli_prompted_login\b/i,
  /\bnot\s+logged\s+in\b/i,
  /需要登录/i,
  /请先.*登录/i,
];

const CLAUDE_MANUAL_SETUP_REQUIRED_PATTERNS = [
  /\bmanual_setup_required\b/i,
  /需要一次性初始化/i,
  /条款确认/i,
];

/**
 * 归一化主进程返回的错误文本（去掉 Error: 前缀等）。
 */
function normalizeUsageErrorText(raw: unknown): string {
  if (raw == null) return "";
  const text = raw instanceof Error ? String(raw.message || "") : String(raw);
  return text.replace(/^error:\s*/i, "").trim();
}

/**
 * 将 Claude 用量错误翻译为“标题 + 提示”两行文案（避免将技术细节直接暴露给用户）。
 */
export function formatClaudeUsageErrorText(raw: unknown, t: TFunction): string {
  const message = normalizeUsageErrorText(raw);

  const defaultTitle = t("common:claudeUsage.errors.default.title", "无法获取 Claude 用量");
  const defaultHint = t("common:claudeUsage.errors.default.hint", "请确认已安装并登录 Claude Code，然后重试");

  if (!message) return `${defaultTitle}\n${defaultHint}`;

  if (TMUX_NOT_FOUND_PATTERNS.some((p) => p.test(message))) {
    const title = t("common:claudeUsage.errors.tmuxNotFound.title", "Claude 用量需要 tmux");
    const hint = t("common:claudeUsage.errors.tmuxNotFound.hint", "请在当前运行环境安装 tmux 后重试");
    return `${title}\n${hint}`;
  }

  if (CLAUDE_CLI_NOT_FOUND_PATTERNS.some((p) => p.test(message))) {
    const title = t("common:claudeUsage.errors.cliNotFound.title", "未检测到 Claude Code CLI");
    const hint = t("common:claudeUsage.errors.cliNotFound.hint", "请在当前运行环境安装 claude 并完成登录");
    return `${title}\n${hint}`;
  }

  if (CLAUDE_AUTH_REQUIRED_PATTERNS.some((p) => p.test(message))) {
    const title = t("common:claudeUsage.errors.authRequired.title", "Claude 未登录");
    const hint = t("common:claudeUsage.errors.authRequired.hint", "请先在终端完成登录，然后重试");
    return `${title}\n${hint}`;
  }

  if (CLAUDE_MANUAL_SETUP_REQUIRED_PATTERNS.some((p) => p.test(message))) {
    const title = t("common:claudeUsage.errors.manualSetup.title", "Claude 需要初始化");
    const hint = t("common:claudeUsage.errors.manualSetup.hint", "请先在终端运行 claude 完成一次初始化");
    return `${title}\n${hint}`;
  }

  return `${defaultTitle}\n${defaultHint}`;
}

/**
 * 触发一次 Claude 用量刷新请求（仅在 UI 层生效；主进程不会自动轮询）。
 */
export function emitClaudeUsageRefresh(source?: string): void {
  try {
    const detail: ClaudeUsageRefreshDetail | undefined = source ? { source } : undefined;
    window.dispatchEvent(new CustomEvent<ClaudeUsageRefreshDetail>(CLAUDE_USAGE_REFRESH_EVENT as any, { detail } as any));
  } catch {}
}
