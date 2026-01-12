// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import openaiIconUrl from "@/assets/providers/openai.svg";
import claudeIconUrl from "@/assets/providers/claude-color.svg";
import geminiIconUrl from "@/assets/providers/gemini-color.svg";

export type BuiltInProviderId = "codex" | "claude" | "gemini";

export type BuiltInProviderMeta = {
  id: BuiltInProviderId;
  /** 默认启动命令（用户可在设置中覆盖） */
  defaultStartupCmd: string;
  /** 内置默认图标（用户可在设置中覆盖为 DataURL） */
  iconUrl: string;
  /** i18n key（显示名称） */
  labelKey: string;
};

/**
 * 判断是否为内置 Provider id。
 */
export function isBuiltInProviderId(id: string): id is BuiltInProviderId {
  return id === "codex" || id === "claude" || id === "gemini";
}

/**
 * 获取内置 Provider 元数据列表（用于默认值与兜底展示）。
 */
export function getBuiltInProviders(): BuiltInProviderMeta[] {
  return [
    { id: "codex", defaultStartupCmd: "codex", iconUrl: openaiIconUrl, labelKey: "providers:items.codex" },
    { id: "claude", defaultStartupCmd: "claude", iconUrl: claudeIconUrl, labelKey: "providers:items.claude" },
    { id: "gemini", defaultStartupCmd: "gemini", iconUrl: geminiIconUrl, labelKey: "providers:items.gemini" },
  ];
}
