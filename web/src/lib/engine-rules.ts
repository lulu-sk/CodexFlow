// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type BuiltInRuleProviderId = "codex" | "claude" | "gemini";

export const BUILT_IN_RULE_PROVIDER_IDS: BuiltInRuleProviderId[] = ["codex", "claude", "gemini"];

const PROVIDER_RULE_FILE_NAME: Record<BuiltInRuleProviderId, string> = {
  codex: "AGENTS.md",
  claude: "CLAUDE.md",
  gemini: "GEMINI.md",
};

/**
 * 中文说明：将任意输入路径安全归一化为去首尾空白后的字符串。
 */
function normalizeInputPath(pathValue: string): string {
  return String(pathValue || "").trim();
}

/**
 * 中文说明：判断路径是否为 Windows 盘符根目录（例如 C:\）。
 */
function isWindowsDriveRoot(pathValue: string): boolean {
  return /^[a-zA-Z]:[\\/]?$/.test(pathValue);
}

/**
 * 中文说明：判断路径是否为 POSIX 根目录（/）。
 */
function isPosixRoot(pathValue: string): boolean {
  return pathValue === "/";
}

/**
 * 中文说明：判断路径是否为 UNC 共享根（例如 \\server\share）。
 */
function isUncShareRoot(pathValue: string): boolean {
  return /^\\\\[^\\/]+[\\/][^\\/]+$/.test(pathValue);
}

/**
 * 中文说明：移除路径尾部的分隔符（保留根目录语义）。
 */
export function trimTrailingPathSeparators(pathValue: string): string {
  const raw = normalizeInputPath(pathValue);
  if (!raw) return "";
  if (isPosixRoot(raw)) return "/";
  if (isWindowsDriveRoot(raw)) return `${raw.slice(0, 1)}:\\`;
  const stripped = raw.replace(/[\\/]+$/, "");
  if (isUncShareRoot(stripped)) return stripped;
  return stripped || raw;
}

/**
 * 中文说明：获取路径末级名称；若为根目录则返回空字符串。
 */
export function getPathBaseName(pathValue: string): string {
  const normalized = trimTrailingPathSeparators(pathValue);
  if (!normalized || isPosixRoot(normalized) || isWindowsDriveRoot(normalized) || isUncShareRoot(normalized)) return "";
  const lastSep = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return lastSep >= 0 ? normalized.slice(lastSep + 1) : normalized;
}

/**
 * 中文说明：获取路径上一级目录；若已是根目录则返回自身。
 */
export function getParentPath(pathValue: string): string {
  const normalized = trimTrailingPathSeparators(pathValue);
  if (!normalized) return "";
  if (isPosixRoot(normalized) || isWindowsDriveRoot(normalized) || isUncShareRoot(normalized)) return normalized;

  const lastSep = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (lastSep < 0) return normalized;
  if (lastSep === 0 && normalized.startsWith("/")) return "/";

  const parentRaw = normalized.slice(0, lastSep);
  if (/^[a-zA-Z]:$/.test(parentRaw)) return `${parentRaw}\\`;
  const parent = trimTrailingPathSeparators(parentRaw);
  return parent || normalized;
}

/**
 * 中文说明：判断当前 provider 的“记录路径”是否需要回退到上一级作为真实引擎根。
 */
function shouldUseParentAsEngineRoot(providerId: BuiltInRuleProviderId, recordedPath: string): boolean {
  const baseName = getPathBaseName(recordedPath).toLowerCase();
  if (providerId === "codex") return baseName === "sessions";
  if (providerId === "gemini") return baseName === "tmp";
  return false;
}

/**
 * 中文说明：将设置中记录的路径规范为真实引擎根路径。
 * - Codex：`.../.codex/sessions` -> `.../.codex`
 * - Gemini：`.../.gemini/tmp` -> `.../.gemini`
 * - Claude：保持不变
 */
export function normalizeEngineRootPath(providerId: BuiltInRuleProviderId, recordedPath: string): string {
  const normalized = trimTrailingPathSeparators(recordedPath);
  if (!normalized) return "";
  if (!shouldUseParentAsEngineRoot(providerId, normalized)) return normalized;
  const parent = getParentPath(normalized);
  return parent || normalized;
}

/**
 * 中文说明：将路径转换为用于去重比较的稳定 key（分隔符统一 + 小写）。
 */
function toPathIdentity(pathValue: string): string {
  return trimTrailingPathSeparators(pathValue).replace(/\\/g, "/").toLowerCase();
}

/**
 * 中文说明：批量规范并去重引擎根路径列表。
 */
export function normalizeEngineRootPaths(providerId: BuiltInRuleProviderId, recordedPaths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(recordedPaths) ? recordedPaths : []) {
    const normalized = normalizeEngineRootPath(providerId, String(item || ""));
    if (!normalized) continue;
    const key = toPathIdentity(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

/**
 * 中文说明：按基路径推断分隔符风格（Windows 使用 `\`，其余使用 `/`）。
 */
function resolvePathSeparator(basePath: string): "\\" | "/" {
  if (/^[a-zA-Z]:/.test(basePath)) return "\\";
  if (basePath.startsWith("\\\\")) return "\\";
  if (basePath.includes("\\")) return "\\";
  return "/";
}

/**
 * 中文说明：按路径风格拼接子路径，适配 Windows/UNC/WSL/POSIX。
 */
export function joinNativePath(basePath: string, childName: string): string {
  const base = trimTrailingPathSeparators(basePath);
  const child = normalizeInputPath(childName).replace(/^[\\/]+/, "");
  if (!base) return child;
  if (!child) return base;
  const separator = resolvePathSeparator(base);
  const normalizedChild = child.replace(/[\\/]+/g, separator);
  if (base.endsWith("\\") || base.endsWith("/")) return `${base}${normalizedChild}`;
  return `${base}${separator}${normalizedChild}`;
}

/**
 * 中文说明：获取 provider 对应的规则文件名。
 */
export function getProviderRuleFileName(providerId: BuiltInRuleProviderId): string {
  return PROVIDER_RULE_FILE_NAME[providerId];
}

/**
 * 中文说明：构造全局规则文件完整路径。
 */
export function getGlobalRuleFilePath(providerId: BuiltInRuleProviderId, engineRootPath: string): string {
  return joinNativePath(engineRootPath, getProviderRuleFileName(providerId));
}

/**
 * 中文说明：构造项目级规则文件完整路径。
 */
export function getProjectRuleFilePath(providerId: BuiltInRuleProviderId, projectRootPath: string): string {
  return joinNativePath(projectRootPath, getProviderRuleFileName(providerId));
}

/**
 * 中文说明：构造 Codex 的全局 config.toml 路径。
 */
export function getCodexConfigTomlPath(engineRootPath: string): string {
  return joinNativePath(engineRootPath, "config.toml");
}
