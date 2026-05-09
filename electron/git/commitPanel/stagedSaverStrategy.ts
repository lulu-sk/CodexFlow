// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type GitStagedSaverStrategy = "index-info" | "reset-add";

/**
 * 把 staged saver 策略值规整为当前受支持的两种实现；未知输入统一回退到 index-info。
 */
export function normalizeGitStagedSaverStrategy(value: unknown): GitStagedSaverStrategy {
  return value === "reset-add" ? "reset-add" : "index-info";
}

/**
 * 从提交 payload 中解析 staged saver 策略开关，统一兼容顶层字段与 options 嵌套字段。
 */
export function resolveGitStagedSaverStrategy(payload: any): GitStagedSaverStrategy {
  return normalizeGitStagedSaverStrategy(payload?.stagedSaverStrategy ?? payload?.options?.stagedSaverStrategy);
}
