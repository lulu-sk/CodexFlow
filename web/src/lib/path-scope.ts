// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 中文说明：将路径规范化为用于历史项目归属比较的 key。
 * - `C:` / `C:\` / `C:/foo` 统一转为 `/mnt/c` 风格；
 * - `\\wsl.localhost\Distro\...` 转为 `/...`；
 * - 其余路径统一为小写 POSIX 风格。
 */
export function normalizePathScopeKey(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const uncPrefix = "\\\\wsl.localhost\\";
  const lower = raw.toLowerCase();
  if (lower.startsWith(uncPrefix)) {
    const rest = raw.slice(uncPrefix.length).replace(/^([^\\]+)\\/, "");
    return normalizePathScopeKey(`/${rest}`);
  }
  const driveMatch = raw.match(/^([a-zA-Z]):(?:[\\/](.*))?$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest = String(driveMatch[2] || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
    return rest ? `/mnt/${drive}/${rest}`.toLowerCase() : `/mnt/${drive}`;
  }
  const normalized = raw.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized === "/") return "/";
  return normalized.replace(/\/+$/, "").toLowerCase();
}

/**
 * 中文说明：判断某个 scope 是否应只允许精确匹配。
 * - 盘符根目录（如 `/mnt/c`）不能把整个盘下所有子目录都算进“当前项目”；
 * - POSIX 根目录同理仅匹配自身。
 */
export function isExactMatchOnlyPathScope(scopeKey: string): boolean {
  const scope = normalizePathScopeKey(scopeKey);
  if (!scope) return false;
  if (scope === "/") return true;
  if (/^\/mnt\/[a-z]$/.test(scope)) return true;
  return false;
}

/**
 * 中文说明：判断候选路径是否属于指定项目 scope。
 * - 普通项目：允许命中子目录；
 * - 根目录项目：仅允许精确匹配。
 */
export function pathMatchesProjectScope(candidateKey: string, scopeKey: string): boolean {
  const candidate = normalizePathScopeKey(candidateKey);
  const scope = normalizePathScopeKey(scopeKey);
  if (!candidate || !scope) return false;
  if (candidate === scope) return true;
  if (isExactMatchOnlyPathScope(scope)) return false;
  return candidate.startsWith(`${scope}/`);
}

/**
 * 中文说明：在多个项目 scope 中，为候选路径选择“最具体”的命中项。
 * - 无命中时返回空串；
 * - 若同时命中父子项目，则优先返回更长的子项目 scope。
 */
export function findBestMatchingProjectScopeKey(candidateKey: string, scopeKeys: readonly string[]): string {
  const candidate = normalizePathScopeKey(candidateKey);
  if (!candidate) return "";
  let best = "";
  for (const rawScope of scopeKeys) {
    const scope = normalizePathScopeKey(rawScope);
    if (!scope || !pathMatchesProjectScope(candidate, scope)) continue;
    if (!best || scope.length > best.length) best = scope;
  }
  return best;
}
