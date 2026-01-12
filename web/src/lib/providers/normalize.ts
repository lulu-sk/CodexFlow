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
 * 将 providers 配置归一化为稳定结构（补齐内置 Provider、补齐 env、清理重复项）。
 */
export function normalizeProvidersSettings(
  input: ProvidersSettings | undefined,
  legacy: { terminal: Required<ProviderEnv>["terminal"]; distro: string; codexCmd: string },
): NormalizedProviders {
  const activeId = String(input?.activeId || "codex").trim() || "codex";

  const items: ProviderItem[] = [];
  const seen = new Set<string>();
  for (const it of Array.isArray(input?.items) ? input!.items : []) {
    const id = String(it?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      displayName: typeof it.displayName === "string" ? it.displayName.trim() : undefined,
      iconDataUrl: typeof it.iconDataUrl === "string" ? it.iconDataUrl.trim() : undefined,
      startupCmd: typeof it.startupCmd === "string" ? it.startupCmd.trim() : undefined,
    });
  }

  for (const builtIn of getBuiltInProviders()) {
    if (seen.has(builtIn.id)) continue;
    seen.add(builtIn.id);
    items.push({ id: builtIn.id });
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

  if (!env.codex) env.codex = { terminal: legacy.terminal, distro: legacy.distro };
  if (!env.claude) env.claude = { terminal: legacy.terminal, distro: legacy.distro };
  if (!env.gemini) env.gemini = { terminal: legacy.terminal, distro: legacy.distro };

  // codexCmd：对 codex 的 startupCmd 做兜底填充（仅在缺失时）
  const codexItem = items.find((x) => x.id === "codex");
  if (codexItem && (!codexItem.startupCmd || codexItem.startupCmd.trim().length === 0)) {
    codexItem.startupCmd = legacy.codexCmd;
  }

  return { activeId, items, env };
}

