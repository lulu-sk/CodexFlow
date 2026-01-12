// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { ProviderItem } from "@/types/host";
import { getBuiltInProviders, isBuiltInProviderId, type BuiltInProviderId } from "./builtins";

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

/**
 * 将一个 ProviderItem 解析为可直接渲染/执行的结构。
 */
export function resolveProvider(item: ProviderItem): ResolvedProvider {
  const id = String(item.id || "").trim();
  const builtIns = getBuiltInProviders();
  const builtIn = builtIns.find((x) => x.id === (id as BuiltInProviderId));
  const isBuiltIn = isBuiltInProviderId(id);
  const iconSrc = (item.iconDataUrl && item.iconDataUrl.trim().length > 0)
    ? item.iconDataUrl.trim()
    : (builtIn?.iconUrl || "");
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

