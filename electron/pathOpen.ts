// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 中文说明：将用于“系统打开/IDE 打开”的原始路径规范化为当前平台更容易识别的本地路径。
 * - Windows 下兼容 Markdown 链接常见的 `/G:/repo/file.ts` 形式；
 * - 其他平台保持原值，避免误改 POSIX 绝对路径。
 */
export function normalizePathOpenCandidate(rawPath: string, platform: NodeJS.Platform = process.platform): string {
  const raw = String(rawPath || "").trim();
  if (!raw) return "";
  if (platform !== "win32") return raw;

  const slashPrefixedDriveMatch = raw.match(/^\/([a-zA-Z]):(?:[\\/](.*))?$/);
  if (slashPrefixedDriveMatch) {
    const drive = slashPrefixedDriveMatch[1].toUpperCase();
    const rest = String(slashPrefixedDriveMatch[2] || "").replace(/[\\/]+/g, "\\");
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }

  return raw.replace(/\//g, "\\");
}
