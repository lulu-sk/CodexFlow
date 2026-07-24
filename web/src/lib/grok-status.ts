// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { TFunction } from "i18next";

export const GROK_USAGE_REFRESH_EVENT = "grok:usage-refresh-request";
export type GrokUsageRefreshDetail = { source?: string };

/**
 * 归一化主进程返回的错误文本。
 */
function normalizeGrokUsageErrorText(raw: unknown): string {
  if (raw == null) return "";
  const text = raw instanceof Error ? String(raw.message || "") : String(raw);
  return text.replace(/^error:\s*/i, "").trim();
}

/**
 * 将 Grok 用量错误转换为面向用户的“标题 + 提示”两行文案。
 */
export function formatGrokUsageErrorText(raw: unknown, t: TFunction): string {
  const message = normalizeGrokUsageErrorText(raw);
  const defaultTitle = t("common:grokUsage.errors.default.title", "无法获取 Grok 账号额度");
  const defaultHint = t("common:grokUsage.errors.default.hint", "请检查网络和 Grok Build 登录状态后重试");
  if (message.includes("GROK_USAGE_API_KEY_UNSUPPORTED"))
    return [
      t("common:grokUsage.errors.apiKey.title", "API Key 不提供账号额度"),
      t("common:grokUsage.errors.apiKey.hint", "这是 Grok Build 的官方限制，请前往 console.x.ai 查看 API 用量"),
    ].join("\n");
  if (message.includes("GROK_USAGE_TEAM_UNSUPPORTED"))
    return [
      t("common:grokUsage.errors.team.title", "团队账号不显示消费者额度"),
      t("common:grokUsage.errors.team.hint", "Grok Build 官方仅向个人 OAuth 账号开放这项额度信息"),
    ].join("\n");
  if (message.includes("GROK_USAGE_AUTH_REQUIRED"))
    return [
      t("common:grokUsage.errors.notLoggedIn.title", "Grok Build 未使用网页登录"),
      t("common:grokUsage.errors.notLoggedIn.hint", "请运行 grok login 完成网页登录，然后刷新"),
    ].join("\n");
  if (message.includes("GROK_USAGE_AUTH_EXPIRED"))
    return [
      t("common:grokUsage.errors.expired.title", "Grok Build 登录已失效"),
      t("common:grokUsage.errors.expired.hint", "请重新运行 grok login 登录，然后刷新"),
    ].join("\n");
  if (message.includes("GROK_USAGE_NOT_AVAILABLE"))
    return [
      t("common:grokUsage.errors.notAvailable.title", "当前账号没有可显示的额度"),
      t("common:grokUsage.errors.notAvailable.hint", "该账号或订阅暂未由 Grok Build 提供额度信息"),
    ].join("\n");
  return [defaultTitle, defaultHint].join("\n");
}

/**
 * 触发一次 Grok 用量刷新请求。
 */
export function emitGrokUsageRefresh(source?: string): void {
  try {
    const detail: GrokUsageRefreshDetail | undefined = source ? { source } : undefined;
    window.dispatchEvent(new CustomEvent<GrokUsageRefreshDetail>(GROK_USAGE_REFRESH_EVENT as any, { detail } as any));
  } catch {}
}
