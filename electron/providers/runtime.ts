// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { normalizeTerminal, type TerminalMode } from "../shells";
import type { AppSettings } from "../settings";

/**
 * Provider 运行时环境配置：
 * - terminal: 终端模式 (native/wsl/windows/pwsh)
 * - distro: WSL 发行版 (仅 wsl 模式有效)
 * - shell: native 模式下的 shell 路径 (可选，默认使用 $SHELL)
 */
export type ProviderRuntimeEnv = {
  terminal: TerminalMode;
  distro?: string;
  shell?: string;
};

/**
 * 从设置中解析当前活跃的 Provider id（为空时回退到 codex）。
 */
export function resolveActiveProviderId(cfg: AppSettings): string {
  const id = String(cfg?.providers?.activeId || "").trim();
  return id || "codex";
}

/**
 * 从设置中解析指定 Provider 的运行环境（terminal/distro/shell）。
 * - 优先读取 providers.env[providerId]
 * - 缺失时回退到 legacy 字段 terminal/distro
 * - terminal 未设置时根据平台自动选择默认值
 */
export function resolveProviderRuntimeEnvFromSettings(cfg: AppSettings, providerId: string): ProviderRuntimeEnv {
  const pid = String(providerId || "").trim();
  // 使用 undefined 而非硬编码 "wsl"，让 normalizeTerminal 根据平台选择默认值
  const globalTerminal = normalizeTerminal((cfg as any)?.terminal);
  const globalDistro = typeof (cfg as any)?.distro === "string" ? String((cfg as any).distro) : "";

  const envMap = (cfg as any)?.providers?.env;
  const env = (envMap && typeof envMap === "object") ? envMap[pid] : undefined;
  const terminal = normalizeTerminal((env as any)?.terminal ?? globalTerminal);

  // 只有 wsl 模式需要 distro
  const distroRaw = terminal === "wsl" && typeof (env as any)?.distro === "string"
    ? String((env as any).distro)
    : (terminal === "wsl" ? globalDistro : "");
  const distro = String(distroRaw || "").trim();

  // native 模式可选 shell
  const shellRaw = terminal === "native" && typeof (env as any)?.shell === "string"
    ? String((env as any).shell)
    : undefined;

  return { terminal, distro: distro || undefined, shell: shellRaw || undefined };
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
