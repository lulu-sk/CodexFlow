// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type HistoryPrefetchVisibleScope = {
  effectiveScope: "current_project" | "project_group" | "all_sessions";
  projectIds: readonly string[];
};

/**
 * 判断指定项目的后台历史预取结果能否合并到当前可见列表。
 */
export function shouldMergeHistoryPrefetchIntoVisibleList(
  targetProjectId: unknown,
  visibleScope: HistoryPrefetchVisibleScope,
): boolean {
  const normalizedTargetProjectId = String(targetProjectId || "").trim();
  if (!normalizedTargetProjectId) return false;
  if (visibleScope.effectiveScope === "all_sessions") return true;
  return visibleScope.projectIds.some((projectId) => String(projectId || "").trim() === normalizedTargetProjectId);
}
