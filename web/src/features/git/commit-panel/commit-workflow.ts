// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitStatusEntry } from "../types";
import {
  buildCommitInclusionItemId,
  isEntryActionable,
  listIncludedCommitItems,
  normalizeCommitRepoRoot,
} from "./inclusion-model";
import {
  normalizeCommitAdvancedOptionsPayload,
  type CommitAdvancedOptionsState,
  type CommitAdvancedOptionsPayload,
  type CommitHooksAvailability,
} from "./commit-options-model";
import { buildCommitWorkflowSelectionItem } from "./partial-commit-model";
import type {
  CommitInclusionState,
  CommitWorkflowItemKind,
  CommitWorkflowSelectionItem,
  PartialCommitSelectionState,
} from "./types";

export type GitCommitIntent = "commit" | "commitAndPush";

export type CommitWorkflowPayload = {
  message: string;
  intent: GitCommitIntent;
  pushAfter: boolean;
  mergeExclusionConfirmed?: boolean;
  confirmedChecks?: string[];
  selections: CommitWorkflowSelectionItem[];
  includedItems: Array<{ path: string; oldPath?: string; kind: CommitWorkflowItemKind; repoRoot?: string }>;
  files: string[];
} & CommitAdvancedOptionsPayload;

/**
 * 把旧的 `pushAfter` 布尔值收敛为结构化提交意图，统一承接“提交”与“提交并推送”两类入口。
 */
export function resolveGitCommitIntent(pushAfter: boolean): GitCommitIntent {
  return pushAfter ? "commitAndPush" : "commit";
}

/**
 * 根据状态条目推导 workflow item 类型，统一复用在“提交选中项”与主提交面板链路。
 */
function resolveWorkflowItemKind(entry: GitStatusEntry): CommitWorkflowItemKind {
  if (entry.ignored) return "ignored";
  if (entry.untracked) return "unversioned";
  return "change";
}

/**
 * 从显式选中的状态条目构建结构化提交项；默认跳过不可直接提交的 ignored 节点。
 */
export function buildCommitWorkflowItemsFromEntries(entries: GitStatusEntry[]): Array<{ path: string; oldPath?: string; kind: CommitWorkflowItemKind }> {
  return entries
    .filter((entry) => isEntryActionable(entry))
    .map((entry) => ({
      path: entry.path,
      oldPath: String(entry.oldPath || "").trim() || undefined,
      kind: resolveWorkflowItemKind(entry),
    }));
}

/**
 * 从 inclusion model 与 partial selection 构建统一 selection 真相源。
 */
export function buildCommitWorkflowSelections(
  inclusionState: CommitInclusionState,
  partialSelectionState: PartialCommitSelectionState,
  repoRoot: string,
): CommitWorkflowSelectionItem[] {
  return listIncludedCommitItems(inclusionState)
    .map((item) => buildCommitWorkflowSelectionItem(item, partialSelectionState, repoRoot))
    .filter((item): item is CommitWorkflowSelectionItem => !!item);
}

/**
 * 从显式选中的状态条目与 partial selection 构建统一 selection 真相源。
 */
export function buildCommitWorkflowSelectionsFromEntries(
  entries: GitStatusEntry[],
  partialSelectionState: PartialCommitSelectionState,
  repoRoot: string,
): CommitWorkflowSelectionItem[] {
  return entries
    .filter((entry) => isEntryActionable(entry))
    .map((entry) => buildCommitWorkflowSelectionItem({
      id: buildCommitInclusionItemId(entry),
      path: entry.path,
      oldPath: String(entry.oldPath || "").trim() || undefined,
      kind: resolveWorkflowItemKind(entry),
      changeListId: String(entry.changeListId || "default").trim() || "default",
      repoRoot: normalizeCommitRepoRoot(entry.repositoryRoot || repoRoot),
      staged: entry.staged,
      tracked: !entry.untracked,
    }, partialSelectionState, repoRoot))
    .filter((item): item is CommitWorkflowSelectionItem => !!item);
}

/**
 * 把结构化 selection 回落为兼容字段，保留 repoRoot 以便主进程在多仓场景下继续按仓分组执行。
 */
function buildCommitWorkflowCompatItems(
  selections: CommitWorkflowSelectionItem[],
): CommitWorkflowPayload["includedItems"] {
  return selections.map((item) => ({
    repoRoot: item.repoRoot,
    path: item.path,
    oldPath: item.oldPath,
    kind: item.kind,
  }));
}

/**
 * 在 commit-all 语义下按当前纳入根集合收敛 tracked changes，只提交被选中根下的已跟踪改动。
 */
function resolveCommitAllEntries(
  entries: GitStatusEntry[],
  inclusionState: CommitInclusionState,
  repoRoot: string,
): GitStatusEntry[] {
  const includedRootSet = new Set(
    (inclusionState.rootsToCommit.length > 0 ? inclusionState.rootsToCommit : inclusionState.includedRepoRoots)
      .map((root) => normalizeCommitRepoRoot(root)),
  );
  return entries.filter((entry) => {
    if (!isEntryActionable(entry) || entry.untracked) return false;
    const entryRepoRoot = normalizeCommitRepoRoot(entry.repositoryRoot || repoRoot);
    if (includedRootSet.size === 0) return entryRepoRoot === normalizeCommitRepoRoot(repoRoot);
    return includedRootSet.has(entryRepoRoot);
  });
}

/**
 * 构建提交 workflow 请求体；`selections` 才是最终提交真相源，`includedItems/files` 仅保留兼容派生值。
 */
export function buildCommitWorkflowPayload(
  inclusionState: CommitInclusionState,
  partialSelectionState: PartialCommitSelectionState,
  repoRoot: string,
  message: string,
  intent: GitCommitIntent,
  commitOptions?: CommitAdvancedOptionsState,
  commitHooks?: CommitHooksAvailability,
  allEntries?: GitStatusEntry[],
): CommitWorkflowPayload {
  const pushAfter = intent === "commitAndPush";
  const selections = inclusionState.isCommitAll && Array.isArray(allEntries)
    ? buildCommitWorkflowSelectionsFromEntries(resolveCommitAllEntries(allEntries, inclusionState, repoRoot), partialSelectionState, repoRoot)
    : buildCommitWorkflowSelections(inclusionState, partialSelectionState, repoRoot);
  const includedItems = buildCommitWorkflowCompatItems(selections);
  return {
    message: String(message || "").trim(),
    intent,
    pushAfter,
    selections,
    includedItems,
    files: includedItems.map((item) => item.path),
    ...normalizeCommitAdvancedOptionsPayload(commitOptions, commitHooks),
  };
}

/**
 * 按显式选中的状态条目构建 workflow 请求，保持右键“提交文件”与主提交面板共用同一 selection 模型。
 */
export function buildCommitWorkflowPayloadFromEntries(
  entries: GitStatusEntry[],
  partialSelectionState: PartialCommitSelectionState,
  repoRoot: string,
  message: string,
  intent: GitCommitIntent,
  commitOptions?: CommitAdvancedOptionsState,
  commitHooks?: CommitHooksAvailability,
): CommitWorkflowPayload {
  const pushAfter = intent === "commitAndPush";
  const selections = buildCommitWorkflowSelectionsFromEntries(entries, partialSelectionState, repoRoot);
  const includedItems = buildCommitWorkflowCompatItems(selections);
  return {
    message: String(message || "").trim(),
    intent,
    pushAfter,
    selections,
    includedItems,
    files: includedItems.map((item) => item.path),
    ...normalizeCommitAdvancedOptionsPayload(commitOptions, commitHooks),
  };
}
