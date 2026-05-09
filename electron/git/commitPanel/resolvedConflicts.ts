// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import {
  listResolvedConflictPathsAsync,
  type GitCommitPanelConflictRuntime,
} from "./conflictMerge";

export type GitCommitPanelOperationState =
  | "normal"
  | "rebasing"
  | "merging"
  | "grafting"
  | "reverting";

export type GitResolvedConflictsHolderSnapshot = {
  source: "resolve-undo";
  operationState: GitCommitPanelOperationState;
  inUpdate: boolean;
  paths: string[];
};

type GitResolvedConflictsHolderCacheEntry = {
  operationState: GitCommitPanelOperationState;
  paths: string[];
};

const resolvedConflictsHolderCache = new Map<string, GitResolvedConflictsHolderCacheEntry>();

/**
 * 规整仓库根路径，作为 resolved conflict holder 的稳定缓存键。
 */
function normalizeResolvedConflictRepoRoot(repoRoot: string): string {
  return String(repoRoot || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 判断当前仓库操作状态是否需要保留 resolved conflict holder 语义。
 */
export function supportsResolvedConflictHolder(
  operationState: GitCommitPanelOperationState,
): boolean {
  return operationState === "merging"
    || operationState === "rebasing"
    || operationState === "grafting"
    || operationState === "reverting";
}

/**
 * 使指定仓库的 resolved conflict holder 失效，确保后续刷新会重新读取 `resolve-undo` 真值。
 */
export function invalidateResolvedConflictHolder(repoRoot: string): void {
  const cacheKey = normalizeResolvedConflictRepoRoot(repoRoot);
  if (!cacheKey) return;
  resolvedConflictsHolderCache.delete(cacheKey);
}

/**
 * 读取统一的 resolved conflict holder 快照；提交面板与 merge session 都必须共享这份状态源。
 */
export async function getResolvedConflictHolderSnapshotAsync(args: {
  runtime: GitCommitPanelConflictRuntime;
  repoRoot: string;
  operationState: GitCommitPanelOperationState;
  forceRefresh?: boolean;
}): Promise<GitResolvedConflictsHolderSnapshot> {
  const cacheKey = normalizeResolvedConflictRepoRoot(args.repoRoot);
  if (!supportsResolvedConflictHolder(args.operationState)) {
    if (cacheKey) resolvedConflictsHolderCache.delete(cacheKey);
    return {
      source: "resolve-undo",
      operationState: args.operationState,
      inUpdate: false,
      paths: [],
    };
  }

  if (!args.forceRefresh && cacheKey) {
    const cached = resolvedConflictsHolderCache.get(cacheKey);
    if (cached && cached.operationState === args.operationState) {
      return {
        source: "resolve-undo",
        operationState: cached.operationState,
        inUpdate: false,
        paths: [...cached.paths],
      };
    }
  }

  const paths = await listResolvedConflictPathsAsync(args.runtime);
  if (cacheKey) {
    resolvedConflictsHolderCache.set(cacheKey, {
      operationState: args.operationState,
      paths: [...paths],
    });
  }
  return {
    source: "resolve-undo",
    operationState: args.operationState,
    inUpdate: false,
    paths,
  };
}
