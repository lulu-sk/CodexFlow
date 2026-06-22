// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type BuiltInAgentProviderId = "codex" | "claude" | "gemini" | "antigravity";

export const BUILT_IN_AGENT_PROVIDER_IDS: readonly BuiltInAgentProviderId[] = ["codex", "claude", "gemini", "antigravity"];

/**
 * 判断输入是否为内置代理引擎 ProviderId。
 */
export function isBuiltInAgentProviderId(value: unknown): value is BuiltInAgentProviderId {
  const id = String(value || "").trim().toLowerCase();
  return id === "codex" || id === "claude" || id === "gemini" || id === "antigravity";
}
