// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import path from "node:path";

const ANTIGRAVITY_CONVERSATIONS_SEGMENT = "/.gemini/antigravity-cli/conversations/";
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/**
 * 判断路径是否指向 Antigravity conversation SQLite 主库。
 */
export function isAntigravityConversationDbPath(filePath: string): boolean {
  const raw = String(filePath || "").trim();
  if (!raw) return false;
  const normalized = raw.replace(/\\/g, "/").toLowerCase();
  if (!normalized.includes(ANTIGRAVITY_CONVERSATIONS_SEGMENT)) return false;
  const baseName = normalized.split("/").pop() || "";
  return baseName.endsWith(".db")
    && !baseName.endsWith(".db-wal")
    && !baseName.endsWith(".db-shm")
    && !baseName.endsWith(".db-journal");
}

/**
 * 扩展历史删除候选；Antigravity SQLite 会话需要连同 WAL/SHM/JOURNAL 辅助文件一起清理。
 */
export function expandAntigravityConversationDeleteCandidates(candidates: readonly string[]): string[] {
  const out: string[] = [];
  const push = (value?: string) => {
    const next = String(value || "").trim();
    if (next && !out.includes(next)) out.push(next);
  };

  for (const item of candidates || []) {
    const candidate = String(item || "").trim();
    if (!candidate) continue;
    push(candidate);
    if (!isAntigravityConversationDbPath(candidate)) continue;
    for (const suffix of SQLITE_SIDECAR_SUFFIXES)
      push(`${candidate}${suffix}`);
  }

  return out;
}

/**
 * 判断路径是否使用 Windows 盘符、UNC 或反斜杠格式。
 */
function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
    || /^[/\\]{2}[^/\\]+[/\\]/.test(value)
    || value.includes("\\");
}

/**
 * 解析已发现 Grok 根目录中的 `summary.json`，并返回规范化后的会话目录。
 */
function resolveGrokSessionDirectory(filePath: string, grokSessionRoots: readonly string[]): string | null {
  const raw = String(filePath || "").trim();
  if (!raw) return null;
  const rawSegments = raw.replace(/\\/g, "/").split("/");
  if (rawSegments.some((segment) => segment === "." || segment === "..")) return null;

  for (const root of grokSessionRoots) {
    const rawRoot = String(root || "").trim();
    if (!rawRoot) continue;
    const windowsStyle = isWindowsStylePath(raw) || isWindowsStylePath(rawRoot);
    const pathApi = windowsStyle ? path.win32 : path.posix;
    const summaryPath = pathApi.resolve(raw);
    if (pathApi.basename(summaryPath).toLowerCase() !== "summary.json") continue;
    const sessionDir = pathApi.dirname(summaryPath);
    const encodedCwdDir = pathApi.dirname(sessionDir);
    const inferredRoot = pathApi.dirname(encodedCwdDir);
    if (!pathApi.basename(sessionDir) || !pathApi.basename(encodedCwdDir)) continue;

    const resolvedRoot = pathApi.resolve(rawRoot);
    const caseInsensitive = /^[a-z]:[\\/]/i.test(summaryPath) && /^[a-z]:[\\/]/i.test(resolvedRoot);
    const inferredRootKey = caseInsensitive ? inferredRoot.toLowerCase() : inferredRoot;
    const resolvedRootKey = caseInsensitive ? resolvedRoot.toLowerCase() : resolvedRoot;
    if (inferredRootKey === resolvedRootKey) return sessionDir;
  }
  return null;
}

/**
 * 判断路径是否为已发现 Grok 根目录中的 `summary.json`。
 */
export function isGrokSessionSummaryPath(filePath: string, grokSessionRoots: readonly string[]): boolean {
  return resolveGrokSessionDirectory(filePath, grokSessionRoots) !== null;
}

/**
 * 扩展通用历史删除候选：Grok 必须删除整个会话目录，Antigravity 必须清理 SQLite 辅助文件。
 */
export function expandHistoryDeleteCandidates(
  candidates: readonly string[],
  grokSessionRoots: readonly string[],
): string[] {
  const antigravityExpanded = expandAntigravityConversationDeleteCandidates(candidates);
  const output: string[] = [];
  for (const candidate of antigravityExpanded) {
    const target = resolveGrokSessionDirectory(candidate, grokSessionRoots) || candidate;
    if (target && !output.includes(target)) output.push(target);
  }
  return output;
}
