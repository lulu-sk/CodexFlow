// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { ProviderEnv, ProviderId, ProviderItem, ProvidersSettings } from "@/types/host";
import { getBuiltInProviders } from "./builtins";

export type NormalizedProviders = {
  activeId: ProviderId;
  items: ProviderItem[];
  env: Record<ProviderId, Required<ProviderEnv>>;
};

/**
 * 将 providers 配置归一化为稳定结构：
 * - 官方内置 Provider 固定顺序在前（便于后续新增官方 Provider 时保持自定义引擎始终在后）
 * - 自定义 Provider 保持相对顺序
 * - 补齐 env、清理重复项，并对 activeId 做兜底
 */
export function normalizeProvidersSettings(
  input: ProvidersSettings | undefined,
  legacy: { terminal: Required<ProviderEnv>["terminal"]; distro: string; codexCmd: string },
): NormalizedProviders {
  const rawActiveId = String(input?.activeId || "codex").trim();
  const builtIns = getBuiltInProviders();
  const builtInOrder = builtIns.map((x) => x.id);
  // 中文说明：builtInOrder 虽然是字面量联合类型数组，但这里需要用 string 来做通用包含判断。
  const builtInSet = new Set<string>(builtInOrder);

  const byId = new Map<string, ProviderItem>();
  const customIdsInOrder: string[] = [];
  for (const it of Array.isArray(input?.items) ? input!.items : []) {
    const id = String(it?.id || "").trim();
    if (!id || byId.has(id)) continue;
    const normalized: ProviderItem = {
      id,
      displayName: typeof it.displayName === "string" ? it.displayName.trim() : undefined,
      iconDataUrl: typeof it.iconDataUrl === "string" ? it.iconDataUrl.trim() : undefined,
      iconDataUrlDark: typeof it.iconDataUrlDark === "string" ? it.iconDataUrlDark.trim() : undefined,
      startupCmd: typeof it.startupCmd === "string" ? it.startupCmd.trim() : undefined,
    };
    byId.set(id, normalized);
    if (!builtInSet.has(id)) customIdsInOrder.push(id);
  }
  for (const id of builtInOrder) {
    if (byId.has(id)) continue;
    byId.set(id, { id });
  }

  const items: ProviderItem[] = [];
  for (const id of builtInOrder) {
    const it = byId.get(id);
    if (it) items.push(it);
  }
  for (const id of customIdsInOrder) {
    const it = byId.get(id);
    if (it) items.push(it);
  }

  const env: Record<string, Required<ProviderEnv>> = {};
  const envInput = (input && typeof input.env === "object" && input.env) ? input.env : {};
  for (const [id, v] of Object.entries(envInput || {})) {
    const key = String(id || "").trim();
    if (!key) continue;
    const terminal = (v?.terminal === "pwsh" || v?.terminal === "windows" || v?.terminal === "wsl") ? v.terminal : legacy.terminal;
    const distro = String(v?.distro || legacy.distro).trim() || legacy.distro;
    env[key] = { terminal, distro };
  }

  for (const builtIn of builtIns) {
    if (env[builtIn.id]) continue;
    env[builtIn.id] = { terminal: legacy.terminal, distro: legacy.distro };
  }

  // codexCmd：对 codex 的 startupCmd 做兜底填充（仅在缺失时）
  const codexItem = items.find((x) => x.id === "codex");
  if (codexItem && (!codexItem.startupCmd || codexItem.startupCmd.trim().length === 0)) {
    codexItem.startupCmd = legacy.codexCmd;
  }

  const activeId = rawActiveId || "codex";
  const activeExists = items.some((x) => String(x?.id || "").trim() === activeId);
  return { activeId: activeExists ? activeId : "codex", items, env };
}
