// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { ProviderEnv, ProviderId, ProviderItem, ProvidersSettings } from "@/types/host";
import { getBuiltInProviders } from "./builtins";

export type NormalizedProviders = {
  activeId: ProviderId;
  items: ProviderItem[];
  env: Record<ProviderId, Required<ProviderEnv>>;
};

export function getDefaultRendererTerminalMode(): Required<ProviderEnv>["terminal"] {
  try {
    const nav = (globalThis as any)?.navigator;
    const raw = String(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || "").toLowerCase();
    if (raw.includes("win")) return "wsl";
  } catch {}
  return "native";
}

export function getDefaultRendererDistro(terminal: ProviderEnv["terminal"] | undefined): string {
  return terminal === "wsl" ? "Ubuntu-24.04" : "";
}

export function getDefaultRendererProviderEnv(overrides?: Partial<ProviderEnv>): Required<ProviderEnv> {
  const terminal = overrides?.terminal || getDefaultRendererTerminalMode();
  const distro = typeof overrides?.distro === "string"
    ? overrides.distro.trim()
    : getDefaultRendererDistro(terminal);
  const shell = typeof overrides?.shell === "string" ? overrides.shell.trim() : "";
  return {
    terminal,
    distro: terminal === "wsl" ? (distro || getDefaultRendererDistro(terminal)) : "",
    shell,
  };
}

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
    // Terminal：始终不允许保存启动命令（只开 shell）。
    if (id === "terminal") normalized.startupCmd = undefined;
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
  const nativeOnlyPlatform = getDefaultRendererTerminalMode() === "native";
  for (const [id, v] of Object.entries(envInput || {})) {
    const key = String(id || "").trim();
    if (!key) continue;
    const validTerminals = ["native", "wsl", "windows", "pwsh"] as const;
    type ValidTerminal = typeof validTerminals[number];
    const rawTerminal = v?.terminal;
    const terminalCandidate = (rawTerminal && validTerminals.includes(rawTerminal as ValidTerminal))
      ? rawTerminal as ValidTerminal
      : legacy.terminal;
    const terminal = nativeOnlyPlatform ? "native" : terminalCandidate;
    const distro = terminal === "wsl"
      ? (String(v?.distro || legacy.distro).trim() || legacy.distro)
      : "";
    const shell = typeof v?.shell === "string" ? v.shell.trim() : "";
    env[key] = { terminal, distro, shell };
  }

  for (const builtIn of builtIns) {
    if (env[builtIn.id]) continue;
    const terminal = nativeOnlyPlatform ? "native" : legacy.terminal;
    env[builtIn.id] = {
      terminal,
      distro: terminal === "wsl" ? legacy.distro : "",
      shell: "",
    };
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
