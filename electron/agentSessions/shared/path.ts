// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import path from "node:path";
import { isUNCPath, uncToWsl } from "../../wsl";

/**
 * 中文说明：去掉路径尾部分隔符，但保留“根目录”语义。
 * - `C:` / `C:\` / `C:/` 统一保留为 `C:\`；
 * - `/mnt/c/` 保留为 `/mnt/c`；
 * - `/` 保留为 `/`；
 * - 其余路径去掉多余的尾部分隔符。
 */
function trimTrailingSeparatorsPreserveRoot(value: string): string {
  try {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const normalized = raw.replace(/\//g, "\\");
    const driveRootMatch = normalized.match(/^([a-zA-Z]):(?:\\+)?$/);
    if (driveRootMatch) return `${driveRootMatch[1].toUpperCase()}:\\`;
    const posixLike = raw.replace(/\\/g, "/");
    const mountRootMatch = posixLike.match(/^\/mnt\/([a-zA-Z])\/?$/);
    if (mountRootMatch) return `/mnt/${mountRootMatch[1].toLowerCase()}`;
    if (/^\/+$/.test(posixLike)) return "/";
    return raw.replace(/[\\/]+$/g, "");
  } catch {
    return String(value || "").trim();
  }
}

/**
 * 中文说明：将 dirKey/scope 统一规范化为可比较的 key。
 * - `C:` / `C:\foo` 转为 `/mnt/c` 风格；
 * - 其余路径统一为小写 POSIX 风格。
 */
function normalizeDirKeyScopeValue(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const driveMatch = raw.match(/^([a-zA-Z]):(?:[\\/](.*))?$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest = String(driveMatch[2] || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
    return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
  }
  const normalized = raw.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized === "/") return "/";
  return normalized.replace(/\/+$/, "").toLowerCase();
}

/**
 * 清理从日志/JSON 中提取的路径候选：
 * - 去除首尾空白与包裹引号
 * - 折叠 JSON 转义反斜杠（例如 C:\\code -> C:\code）
 * - 去除尾部分隔符
 */
export function tidyPathCandidate(value: string): string {
  try {
    let s = String(value || "")
      .replace(/\\n/g, "")
      .replace(/^"|"$/g, "")
      .replace(/^'|'$/g, "")
      .trim();
    s = s.replace(/\\\\/g, "\\").trim();
    s = trimTrailingSeparatorsPreserveRoot(s);
    return s;
  } catch {
    return String(value || "").trim();
  }
}

/**
 * 中文说明：判断某个规范化后的目录 scope 是否应只允许“精确匹配”。
 * - 盘符根目录（如 `/mnt/c`）不应吞掉整盘所有子目录会话；
 * - POSIX 根目录（`/`）同样仅允许匹配自身。
 */
export function isExactMatchOnlyDirKeyScope(scopeKey: string): boolean {
  const scope = normalizeDirKeyScopeValue(scopeKey);
  if (!scope) return false;
  if (scope === "/") return true;
  if (/^\/mnt\/[a-z]$/.test(scope)) return true;
  return false;
}

/**
 * 中文说明：判断候选 dirKey 是否属于指定 scope。
 * - 普通项目目录：允许“自身或子目录”命中；
 * - 根目录 scope：仅允许精确命中，避免 `C:\` 吞掉 `C:\Users\...`。
 */
export function pathMatchesDirKeyScope(candidateKey: string, scopeKey: string): boolean {
  const candidate = normalizeDirKeyScopeValue(candidateKey);
  const scope = normalizeDirKeyScopeValue(scopeKey);
  if (!candidate || !scope) return false;
  if (candidate === scope) return true;
  if (isExactMatchOnlyDirKeyScope(scope)) return false;
  return candidate.startsWith(`${scope}/`);
}

/**
 * 中文说明：在多个项目 scope 中，为候选路径选择“最具体”的命中项。
 * - 无命中时返回空串；
 * - 父子项目同时命中时，优先返回路径更长的子项目 scope。
 */
export function findBestMatchingDirKeyScope(candidateKey: string, scopeKeys: readonly string[]): string {
  const candidate = normalizeDirKeyScopeValue(candidateKey);
  if (!candidate) return "";
  let best = "";
  for (const rawScope of scopeKeys) {
    const scope = normalizeDirKeyScopeValue(rawScope);
    if (!scope || !pathMatchesDirKeyScope(candidate, scope)) continue;
    if (!best || scope.length > best.length) best = scope;
  }
  return best;
}

/**
 * 从文件路径获取用于项目归属匹配的 dirKey（优先归一为 WSL 风格）。
 */
export function dirKeyOfFilePath(filePath: string): string {
  try {
    const d = path.dirname(filePath);
    const s = d.replace(/\\/g, "/").replace(/\/+/g, "/");
    const m = s.match(/^([a-zA-Z]):\/(.*)$/);
    if (m) return (`/mnt/${m[1].toLowerCase()}/${m[2]}`).replace(/\/+/g, "/").replace(/\/+$/, "").toLowerCase();
    if (isUNCPath(d)) {
      const info = uncToWsl(d);
      if (info) return info.wslPath.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "").toLowerCase();
    }
    return s.replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(filePath || "").replace(/\\/g, "/").toLowerCase();
  }
}

/**
 * 从 cwd/项目路径计算用于匹配的 dirKey（不降一级目录）。
 */
export function dirKeyFromCwd(dirPath: string): string {
  try {
    let d = tidyPathCandidate(dirPath);
    if (isUNCPath(d)) {
      const info = uncToWsl(d);
      if (info) d = info.wslPath;
    } else {
      const m = d.match(/^([a-zA-Z]):(?:\\(.*))?$/);
      if (m) {
        const rest = String(m[2] || "").replace(/\\/g, "/");
        d = rest ? `/mnt/${m[1].toLowerCase()}/${rest}` : `/mnt/${m[1].toLowerCase()}`;
      }
    }
    return d.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(dirPath || "").replace(/\\/g, "/").toLowerCase();
  }
}

