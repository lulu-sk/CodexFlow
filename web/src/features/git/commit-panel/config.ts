// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 提交面板 many files 默认阈值，对齐上游 `ChangesBrowserSpecificNode` 的默认行为。
 */
export const DEFAULT_COMMIT_PANEL_MANY_FILES_THRESHOLD = 1000;
export const COMMIT_TREE_RESET_THRESHOLD = 30_000;
export const COMMIT_TREE_EXPAND_SAFE_CHILD_THRESHOLD = 10_000;
export const COMMIT_TREE_PRELOAD_THRESHOLD = 1_000;
export const COMMIT_TREE_ROW_HEIGHT = 24;
export const SPECIAL_FILES_ROW_HEIGHT = 28;

/**
 * 提交面板默认 changelist 标识；用于刷新后回落选择与默认展开策略。
 */
export const DEFAULT_COMMIT_PANEL_CHANGE_LIST_ID = "default";

/**
 * 归一化 many files 阈值；无效输入统一回退到上游默认值。
 */
export function normalizeCommitPanelManyFilesThreshold(value: unknown): number {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return DEFAULT_COMMIT_PANEL_MANY_FILES_THRESHOLD;
  return Math.max(1, Math.floor(normalized));
}

/**
 * 判断当前变更树是否已进入超大树分支；该阈值统一用于 reset、默认展开与 Select In enablement。
 */
export function isCommitTreeResetRequired(totalFileCount: number): boolean {
  return Math.max(0, Math.floor(Number(totalFileCount) || 0)) > COMMIT_TREE_RESET_THRESHOLD;
}

/**
 * 判断指定节点是否允许自动安全展开，避免对子节点规模过大的目录做深层展开。
 */
export function canCommitTreeNodeExpandSafely(childFileCount: number): boolean {
  return Math.max(0, Math.floor(Number(childFileCount) || 0)) <= COMMIT_TREE_EXPAND_SAFE_CHILD_THRESHOLD;
}

/**
 * 判断当前文件规模下是否允许执行预热与轻量状态恢复，统一复用 `1000` 级阈值。
 */
export function canPreloadCommitTree(totalFileCount: number): boolean {
  return Math.max(0, Math.floor(Number(totalFileCount) || 0)) <= COMMIT_TREE_PRELOAD_THRESHOLD;
}

/**
 * 归一化 grouping key 集并按平台权重稳定排序。
 */
export function normalizeCommitGroupingKeys(
  groupingKeys: unknown,
  fallbackDirectory: boolean = true,
): Array<"directory" | "module" | "repository"> {
  const input = Array.isArray(groupingKeys) ? groupingKeys : (fallbackDirectory ? ["directory"] : []);
  const out: Array<"directory" | "module" | "repository"> = [];
  for (const item of input) {
    if (item !== "directory" && item !== "module" && item !== "repository") continue;
    if (!out.includes(item)) out.push(item);
  }
  const weight = { repository: 30, module: 20, directory: 10 } as const;
  return out.sort((left, right) => weight[right] - weight[left] || left.localeCompare(right));
}
