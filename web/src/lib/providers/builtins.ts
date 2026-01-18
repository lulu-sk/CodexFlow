// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import openaiIconUrl from "@/assets/providers/openai.svg";
import openaiDarkIconUrl from "@/assets/providers/openai-dark.png";
import claudeIconUrl from "@/assets/providers/claude-color.svg";
import geminiIconUrl from "@/assets/providers/gemini-color.svg";
import terminalIconUrl from "@/assets/providers/black-terminal-icon.svg";
import terminalDarkIconUrl from "@/assets/providers/white-terminal-icon.svg";
import type { ThemeMode } from "@/lib/theme";

export type BuiltInProviderId = "codex" | "claude" | "gemini" | "terminal";

export type BuiltInSessionProviderId = "codex" | "claude" | "gemini";

export type BuiltInProviderMeta = {
  id: BuiltInProviderId;
  /** 默认启动命令（用户可在设置中覆盖） */
  defaultStartupCmd: string;
  /** 内置默认图标（用户可在设置中覆盖为 DataURL） */
  iconUrl: string;
  /** 内置暗色模式图标（用户可在设置中覆盖为 DataURL）；为空则回退到 iconUrl */
  iconUrlDark?: string;
  /** i18n key（显示名称） */
  labelKey: string;
};

/** 默认 Provider 图标（亮色/默认）。 */
export const DEFAULT_PROVIDER_ICON_URL = openaiIconUrl;
/** 默认 Provider 图标（暗色）。 */
export const DEFAULT_PROVIDER_ICON_URL_DARK = openaiDarkIconUrl;

/**
 * 获取默认 Provider 图标（按主题模式）。
 */
export function getDefaultProviderIconUrl(themeMode?: ThemeMode): string {
  return themeMode === "dark" ? DEFAULT_PROVIDER_ICON_URL_DARK : DEFAULT_PROVIDER_ICON_URL;
}

/**
 * 判断是否为内置 Provider id。
 */
export function isBuiltInProviderId(id: string): id is BuiltInProviderId {
  return id === "codex" || id === "claude" || id === "gemini" || id === "terminal";
}

/**
 * 判断是否为“会话型内置 Provider”（具备会话扫描/历史索引能力：codex/claude/gemini）。
 */
export function isBuiltInSessionProviderId(id: string): id is BuiltInSessionProviderId {
  return id === "codex" || id === "claude" || id === "gemini";
}

/**
 * 获取内置 Provider 元数据列表（用于默认值与兜底展示）。
 */
export function getBuiltInProviders(): BuiltInProviderMeta[] {
  return [
    { id: "codex", defaultStartupCmd: "codex", iconUrl: openaiIconUrl, iconUrlDark: openaiDarkIconUrl, labelKey: "providers:items.codex" },
    { id: "claude", defaultStartupCmd: "claude", iconUrl: claudeIconUrl, iconUrlDark: claudeIconUrl, labelKey: "providers:items.claude" },
    { id: "gemini", defaultStartupCmd: "gemini", iconUrl: geminiIconUrl, iconUrlDark: geminiIconUrl, labelKey: "providers:items.gemini" },
    { id: "terminal", defaultStartupCmd: "", iconUrl: terminalIconUrl, iconUrlDark: terminalDarkIconUrl, labelKey: "providers:items.terminal" },
  ];
}
