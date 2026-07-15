// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type TerminalCapabilitySettings = {
  /** 缺失或退化时补齐 xterm-256color，保留其它有效 TERM。 */
  normalizeTerm?: boolean;
  /** 缺失且未声明 NO_COLOR 时补齐 COLORTERM=truecolor。 */
  trueColor?: boolean;
};

export const DEFAULT_TERMINAL_CAPABILITIES: Required<TerminalCapabilitySettings> = {
  normalizeTerm: true,
  trueColor: false,
};

/**
 * 清理非交互父进程注入的颜色控制变量，避免污染新建的交互式终端。
 * 用户通过终端环境显式传入的同名变量会在调用方后续合并时恢复。
 */
export function sanitizeInheritedTerminalColorEnvironment(
  input: Record<string, string>,
): Record<string, string> {
  const env = { ...input };
  if (String(env.TERM || "").trim().toLowerCase() !== "dumb")
    return env;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  if (!String(env.COLORTERM || "").trim())
    delete env.COLORTERM;
  return env;
}

/**
 * 归一化终端能力设置，确保旧设置文件也能获得稳定默认值。
 */
export function normalizeTerminalCapabilitySettings(raw: unknown): Required<TerminalCapabilitySettings> {
  const source = raw && typeof raw === "object" ? raw as TerminalCapabilitySettings : {};
  return {
    normalizeTerm: source.normalizeTerm !== false,
    trueColor: source.trueColor === true,
  };
}

/**
 * 按设置补齐终端能力环境变量，不覆盖用户已有的有效声明。
 */
export function applyTerminalCapabilityEnvironment(
  input: Record<string, string>,
  rawSettings: unknown,
): Record<string, string> {
  const env = { ...input };
  const capabilities = normalizeTerminalCapabilitySettings(rawSettings);
  const currentTerm = String(env.TERM || "").trim();
  if (capabilities.normalizeTerm && (!currentTerm || currentTerm.toLowerCase() === "dumb"))
    env.TERM = "xterm-256color";

  const hasNoColor = Object.prototype.hasOwnProperty.call(env, "NO_COLOR");
  if (capabilities.trueColor && !hasNoColor && !String(env.COLORTERM || "").trim())
    env.COLORTERM = "truecolor";
  return env;
}
