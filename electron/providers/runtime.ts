// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { normalizeTerminal, type TerminalMode } from "../shells";
import type { AppSettings } from "../settings";

export type ProviderRuntimeEnv = { terminal: TerminalMode; distro?: string };

/**
 * 从设置中解析当前活跃的 Provider id（为空时回退到 codex）。
 */
export function resolveActiveProviderId(cfg: AppSettings): string {
  const id = String(cfg?.providers?.activeId || "").trim();
  return id || "codex";
}

/**
 * 从设置中解析指定 Provider 的运行环境（terminal/distro）。
 * - 优先读取 providers.env[providerId]
 * - 缺失时回退到 legacy 字段 terminal/distro
 */
export function resolveProviderRuntimeEnvFromSettings(cfg: AppSettings, providerId: string): ProviderRuntimeEnv {
  const pid = String(providerId || "").trim();
  const globalTerminal = normalizeTerminal((cfg as any)?.terminal ?? "wsl");
  const globalDistro = typeof (cfg as any)?.distro === "string" ? String((cfg as any).distro) : "";

  const envMap = (cfg as any)?.providers?.env;
  const env = (envMap && typeof envMap === "object") ? envMap[pid] : undefined;
  const terminal = normalizeTerminal((env as any)?.terminal ?? globalTerminal);

  const distroRaw = typeof (env as any)?.distro === "string" ? String((env as any).distro) : globalDistro;
  const distro = String(distroRaw || "").trim();
  return { terminal, distro: distro || undefined };
}

/**
 * 从设置中解析指定 Provider 的默认启动命令。
 * - Terminal：始终返回空字符串（只打开 shell），忽略任何覆盖
 * - 优先读取 providers.items 对应条目的 startupCmd（空/仅空白则视为未设置）
 * - 内置兜底：
 *   - codex：cfg.codexCmd（再回退到 "codex"）
 *   - claude/gemini：使用各自的默认命令
 * - 其它自定义 Provider：缺失时返回空字符串
 */
export function resolveProviderStartupCmdFromSettings(cfg: AppSettings, providerId: string): string {
  const pid = String(providerId || "").trim();
  if (pid === "terminal") return "";
  const items = Array.isArray((cfg as any)?.providers?.items) ? (cfg as any).providers.items : [];
  const hit = items.find((x: any) => String(x?.id || "").trim() === pid);
  const fromItem = (hit && typeof hit.startupCmd === "string") ? String(hit.startupCmd).trim() : "";
  if (fromItem) return fromItem;

  if (pid === "claude") return "claude";
  if (pid === "gemini") return "gemini";
  if (pid === "codex") {
    const legacy = typeof (cfg as any)?.codexCmd === "string" ? String((cfg as any).codexCmd).trim() : "";
    return legacy || "codex";
  }
  return "";
}
