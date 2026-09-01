// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import {
  findBestMatchingDirKeyScope,
  normalizeDirKeyScopeValue,
  pathMatchesNormalizedDirKeyScope,
} from "./agentSessions/shared/path";

export type HistoryScopeMode = "current_project" | "project_group" | "all_sessions";
export type HistoryScopeProviderId = "codex" | "claude" | "gemini" | "antigravity" | "grok";

export type HistoryScopeFilterItem = {
  providerId?: HistoryScopeProviderId | string;
  dirKey?: string;
  projectHash?: string;
  filePath?: string;
};

export type HistoryScopeFilterOptions = {
  scope: HistoryScopeMode;
  currentProjectNeedles: readonly string[];
  allProjectNeedles: readonly string[];
  geminiHashNeedles?: ReadonlySet<string>;
  extractGeminiProjectHashFromPath?: (filePath: string) => string | null | undefined;
};

export type HistoryScopeMatcher = (item: HistoryScopeFilterItem) => boolean;

type CompiledHistoryProjectScope = {
  key: string;
  current: boolean;
};

/**
 * 中文说明：解析候选历史路径命中的“最具体项目 scope”。
 */
export function resolveBestHistoryProjectScope(dirKey: string | undefined, scopeKeys: readonly string[]): string {
  const normalized = String(dirKey || "").trim();
  if (!normalized) return "";
  return findBestMatchingDirKeyScope(normalized, scopeKeys);
}

/**
 * 中文说明：编译历史范围匹配器，复用规范化后的项目路径并按最具体路径优先匹配。
 */
export function createHistoryScopeMatcher(options: HistoryScopeFilterOptions): HistoryScopeMatcher {
  if (options.scope === "all_sessions") return () => true;

  const currentScopes = new Set(
    options.currentProjectNeedles.map((item) => normalizeDirKeyScopeValue(item)).filter(Boolean),
  );
  const allScopes = new Set(
    [...options.allProjectNeedles, ...options.currentProjectNeedles]
      .map((item) => normalizeDirKeyScopeValue(item))
      .filter(Boolean),
  );
  const projectScopes: CompiledHistoryProjectScope[] = Array.from(allScopes)
    .map((key) => ({ key, current: currentScopes.has(key) }))
    .sort((left, right) => right.key.length - left.key.length);

  return (item: HistoryScopeFilterItem): boolean => {
    const dirKey = normalizeDirKeyScopeValue(String(item.dirKey || ""));
    if (dirKey) {
      const owner = projectScopes.find((scope) => pathMatchesNormalizedDirKeyScope(dirKey, scope.key));
      if (owner) return owner.current;
    }

    const providerId = String(item.providerId || "").trim().toLowerCase();
    if (providerId !== "gemini") return false;

    const geminiHashNeedles = options.geminiHashNeedles;
    if (!geminiHashNeedles || geminiHashNeedles.size <= 0) return false;

    const explicitHash = String(item.projectHash || "").trim().toLowerCase();
    const derivedHash = options.extractGeminiProjectHashFromPath
      ? String(options.extractGeminiProjectHashFromPath(String(item.filePath || "")) || "").trim().toLowerCase()
      : "";
    const targetHash = explicitHash || derivedHash;
    return !!targetHash && geminiHashNeedles.has(targetHash);
  };
}

/**
 * 中文说明：判断单条历史是否属于当前历史范围。
 * - 若同时命中父项目与子项目，统一归属到更具体的子项目；
 * - Gemini 在缺失路径时，允许退回 `projectHash` 归属。
 */
export function historyItemBelongsToScope(
  item: HistoryScopeFilterItem,
  options: HistoryScopeFilterOptions,
): boolean {
  return createHistoryScopeMatcher(options)(item);
}
