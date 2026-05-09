// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitStatusEntry, GitStatusSnapshot } from "../types";
import type { CommitWorkflowPayload } from "./commit-workflow";
import { normalizeCommitRepoRoot } from "./inclusion-model";

export type GitMergeExclusionPrecheckResult = {
  requiresConfirmation: boolean;
  affectedRepoRoots: string[];
  excludedEntries: GitStatusEntry[];
};

/**
 * 为“仓库根 + 路径”生成稳定比较键，供 merge exclusion 检查在多仓场景下精确比对已纳入与被排除条目。
 */
function buildTrackedEntryKey(pathText: string, repoRoot?: string): string {
  const normalizedPath = String(pathText || "").trim().replace(/\\/g, "/");
  const normalizedRepoRoot = normalizeCommitRepoRoot(repoRoot);
  return normalizedRepoRoot ? `${normalizedRepoRoot}::${normalizedPath}` : normalizedPath;
}

/**
 * 检查 merge 过程中是否仍有当前目标仓库的 tracked changes 被排除在本次提交之外，对齐 IDEA 的 excluded-changes 确认流。
 */
export function resolveMergeExclusionPrecheck(args: {
  status: GitStatusSnapshot | null | undefined;
  payload: Pick<CommitWorkflowPayload, "selections">;
  fallbackRepoRoot: string;
}): GitMergeExclusionPrecheckResult {
  const operationState = String(args.status?.operationState || "").trim();
  if (operationState !== "merging") {
    return {
      requiresConfirmation: false,
      affectedRepoRoots: [],
      excludedEntries: [],
    };
  }

  const trackedSelections = (args.payload?.selections || []).filter((selection) => selection.kind === "change");
  const includedTrackedKeys = new Set(
    trackedSelections.map((selection) => buildTrackedEntryKey(selection.path, selection.repoRoot || args.fallbackRepoRoot)),
  );
  if (includedTrackedKeys.size <= 0) {
    return {
      requiresConfirmation: false,
      affectedRepoRoots: [],
      excludedEntries: [],
    };
  }

  const affectedRepoRoots = Array.from(new Set(
    trackedSelections
      .map((selection) => normalizeCommitRepoRoot(selection.repoRoot || args.fallbackRepoRoot))
      .filter(Boolean),
  ));
  const affectedRepoRootSet = new Set(affectedRepoRoots);
  const excludedEntries = (args.status?.entries || []).filter((entry) => {
    if (entry.untracked || entry.ignored) return false;
    const entryRepoRoot = normalizeCommitRepoRoot(entry.repositoryRoot || args.fallbackRepoRoot);
    if (!affectedRepoRootSet.has(entryRepoRoot)) return false;
    return !includedTrackedKeys.has(buildTrackedEntryKey(entry.path, entryRepoRoot));
  });

  return {
    requiresConfirmation: excludedEntries.length > 0,
    affectedRepoRoots,
    excludedEntries,
  };
}
