// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { ProviderItem } from "@/types/host";
import type { ThemeMode } from "@/lib/theme";
import { getBuiltInProviders, getDefaultProviderIconUrl, isBuiltInProviderId, type BuiltInProviderId, type BuiltInProviderMeta } from "./builtins";

export type ResolvedProvider = {
  id: string;
  isBuiltIn: boolean;
  /** 渲染层最终展示的图标 src（url 或 dataURL） */
  iconSrc: string;
  /** 启动命令（用于新建/启动） */
  startupCmd: string;
  /** i18n key（内置）或用户自定义名称（自定义） */
  labelKey?: string;
  displayName?: string;
};

export type ResolveProviderOptions = {
  /** 主题模式：用于选择暗色/亮色图标；不传则按亮色/默认逻辑处理。 */
  themeMode?: ThemeMode;
};

/**
 * 根据主题模式选择 Provider 的图标（带“暗色图标”字段与默认兜底）。
 */
function resolveProviderIconSrc(item: ProviderItem, builtIn: BuiltInProviderMeta | undefined, themeMode?: ThemeMode): string {
  const lightOverride = typeof item.iconDataUrl === "string" ? item.iconDataUrl.trim() : "";
  const darkOverride = typeof item.iconDataUrlDark === "string" ? item.iconDataUrlDark.trim() : "";

  if (themeMode === "dark") {
    if (darkOverride) return darkOverride;
    if (lightOverride) return lightOverride;
    return (builtIn?.iconUrlDark || builtIn?.iconUrl || getDefaultProviderIconUrl("dark")) || getDefaultProviderIconUrl("dark");
  }

  if (lightOverride) return lightOverride;
  return (builtIn?.iconUrl || getDefaultProviderIconUrl(themeMode)) || getDefaultProviderIconUrl(themeMode);
}

/**
 * 将一个 ProviderItem 解析为可直接渲染/执行的结构。
 */
export function resolveProvider(item: ProviderItem, options?: ResolveProviderOptions): ResolvedProvider {
  const id = String(item.id || "").trim();
  const builtIns = getBuiltInProviders();
  const builtIn = builtIns.find((x) => x.id === (id as BuiltInProviderId));
  const isBuiltIn = isBuiltInProviderId(id);
  const iconSrc = resolveProviderIconSrc(item, builtIn, options?.themeMode);
  const startupCmd = (item.startupCmd && item.startupCmd.trim().length > 0)
    ? item.startupCmd.trim()
    : (builtIn?.defaultStartupCmd || "");
  return {
    id,
    isBuiltIn,
    iconSrc,
    startupCmd,
    labelKey: builtIn?.labelKey,
    displayName: typeof item.displayName === "string" ? item.displayName.trim() : undefined,
  };
}

