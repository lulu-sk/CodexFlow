// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitLocalChangesConfig, GitStatusEntry, GitViewOptions } from "../types";

export type CommitOpenIntent = "singleClick" | "enter" | "doubleClick" | "f4";
export type CommitResolvedOpenAction = "diff" | "source" | "none";

/**
 * 判断指定条目在当前上下文里是否允许直接打开 Diff。
 */
export function canOpenDiffForCommitEntry(entry: GitStatusEntry | null | undefined): boolean {
  return !!entry && !entry.ignored;
}

/**
 * 按 IDEA 的判定顺序解析文件激活动作；`F4` 永远打开源文件，`Enter/双击` 先看“是否以 Diff 方式打开”配置。
 */
export function resolveCommitOpenAction(
  viewOptions: GitViewOptions,
  intent: CommitOpenIntent,
  canOpenDiff: boolean,
): CommitResolvedOpenAction {
  if (intent === "singleClick") return viewOptions.detailsPreviewShown && canOpenDiff ? "diff" : "none";
  if (intent === "f4") return "source";
  if (!viewOptions.diffPreviewOnDoubleClickOrEnter) return "source";
  return canOpenDiff ? "diff" : "source";
}

/**
 * 根据本地更改配置推导提交面板文件预览时应打开的 Diff 模式。
 */
export function resolveCommitPreviewDiffMode(
  entry: GitStatusEntry,
  localChangesConfig: GitLocalChangesConfig,
): "working" | "staged" {
  if (localChangesConfig.stagingAreaEnabled && entry.staged) return "staged";
  if (entry.staged && !entry.unstaged && !entry.untracked) return "staged";
  return "working";
}
