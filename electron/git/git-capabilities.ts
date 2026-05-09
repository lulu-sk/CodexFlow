// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type GitSemanticVersion = {
  major: number;
  minor: number;
  patch: number;
};

export type GitCapabilityState = {
  stashPushPathspecSupported: boolean;
};

/**
 * 从 `git version` 文本里提取三段语义化版本号；无法识别时返回 `null`。
 */
export function parseGitVersionOutput(versionText: string): GitSemanticVersion | null {
  const match = String(versionText || "").match(/git version\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10) || 0,
    minor: Number.parseInt(match[2], 10) || 0,
    patch: Number.parseInt(match[3], 10) || 0,
  };
}

/**
 * 判断当前 Git 版本是否达到目标版本；比较顺序固定为 major/minor/patch。
 */
export function isGitVersionAtLeast(
  version: GitSemanticVersion | null | undefined,
  target: GitSemanticVersion,
): boolean {
  if (!version) return false;
  if (version.major !== target.major) return version.major > target.major;
  if (version.minor !== target.minor) return version.minor > target.minor;
  return version.patch >= target.patch;
}

/**
 * 把 `git version` 输出映射为当前仓库前端需要感知的 Git 能力快照。
 */
export function buildGitCapabilityState(versionText: string): GitCapabilityState {
  const version = parseGitVersionOutput(versionText);
  return {
    stashPushPathspecSupported: isGitVersionAtLeast(version, { major: 2, minor: 13, patch: 0 }),
  };
}
