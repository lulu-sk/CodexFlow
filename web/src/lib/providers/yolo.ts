// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type YoloProviderId = "codex" | "claude" | "gemini";

/**
 * 判断指定 Provider 是否支持 YOLO 预设命令。
 */
export function isYoloSupportedProviderId(providerId: string): providerId is YoloProviderId {
  return providerId === "codex" || providerId === "claude" || providerId === "gemini";
}

/**
 * 获取内置三引擎的 YOLO 预设启动命令。
 * - Codex：codex --yolo
 * - Claude：claude --dangerously-skip-permissions
 * - Gemini：gemini --yolo
 */
export function getYoloPresetStartupCmd(providerId: string): string | null {
  if (providerId === "codex") return "codex --yolo";
  if (providerId === "claude") return "claude --dangerously-skip-permissions";
  if (providerId === "gemini") return "gemini --yolo";
  return null;
}

/**
 * 归一化命令字符串用于对比（去除首尾空白并合并连续空白）。
 */
export function normalizeCliCommandForCompare(cmd: string): string {
  return String(cmd || "").trim().replace(/\s+/g, " ");
}

/**
 * 判断当前 startupCmd 是否等于该 Provider 的 YOLO 预设命令。
 */
export function isYoloPresetEnabled(providerId: string, startupCmd: string | null | undefined): boolean {
  if (!isYoloSupportedProviderId(providerId)) return false;
  const preset = getYoloPresetStartupCmd(providerId);
  if (!preset) return false;
  const cur = normalizeCliCommandForCompare(String(startupCmd || ""));
  return cur.length > 0 && cur === normalizeCliCommandForCompare(preset);
}

