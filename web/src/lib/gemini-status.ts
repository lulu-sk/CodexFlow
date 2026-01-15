// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { TFunction } from "i18next";

// 触发 Gemini 用量刷新（渲染进程全局事件）
// 说明：顶部栏用量组件监听并在冷却后触发刷新。
export const GEMINI_USAGE_REFRESH_EVENT = "gemini:usage-refresh-request";
export type GeminiUsageRefreshDetail = { source?: string };

const GEMINI_NOT_LOGGED_IN_PATTERNS = [
  /oauth_creds\.json/i,
  /未找到\s*gemini\s*登录凭据/i,
  /login\s+credentials/i,
  /refresh_token/i,
];

const GEMINI_PROJECT_REQUIRED_PATTERNS = [
  /GOOGLE_CLOUD_PROJECT/i,
  /projectId/i,
  /cloudaicompanionProject/i,
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
 * 将 Gemini 用量错误翻译为“标题 + 提示”两行文案（避免将技术细节直接暴露给用户）。
 */
export function formatGeminiUsageErrorText(raw: unknown, t: TFunction): string {
  const message = normalizeUsageErrorText(raw);

  const defaultTitle = t("common:geminiUsage.errors.default.title", "无法获取 Gemini 用量");
  const defaultHint = t("common:geminiUsage.errors.default.hint", "请确认已安装并登录 Gemini，然后重试");

  if (!message) return `${defaultTitle}\n${defaultHint}`;

  if (GEMINI_NOT_LOGGED_IN_PATTERNS.some((p) => p.test(message))) {
    const title = t("common:geminiUsage.errors.notLoggedIn.title", "Gemini 未登录");
    const hint = t("common:geminiUsage.errors.notLoggedIn.hint", "请在对应运行环境完成登录后重试");
    return `${title}\n${hint}`;
  }

  if (GEMINI_PROJECT_REQUIRED_PATTERNS.some((p) => p.test(message))) {
    const title = t("common:geminiUsage.errors.projectRequired.title", "Gemini 需要项目配置");
    const hint = t("common:geminiUsage.errors.projectRequired.hint", "请配置项目后重试");
    return `${title}\n${hint}`;
  }

  return `${defaultTitle}\n${defaultHint}`;
}

/**
 * 触发一次 Gemini 用量刷新请求（仅在 UI 层生效；主进程不会自动轮询）。
 */
export function emitGeminiUsageRefresh(source?: string): void {
  try {
    const detail: GeminiUsageRefreshDetail | undefined = source ? { source } : undefined;
    window.dispatchEvent(new CustomEvent<GeminiUsageRefreshDetail>(GEMINI_USAGE_REFRESH_EVENT as any, { detail } as any));
  } catch {}
}
