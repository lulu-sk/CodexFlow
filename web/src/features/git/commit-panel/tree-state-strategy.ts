// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { canCommitTreeNodeExpandSafely, DEFAULT_COMMIT_PANEL_CHANGE_LIST_ID } from "./config";
import { buildCommitInclusionItemId, buildCommitInclusionLookupKey } from "./inclusion-model";
import type { ChangeEntryGroup, CommitInclusionState, CommitTreeGroup, CommitTreeNode } from "./types";

type AutoExpandTreeNode<TNode> = {
  key: string;
  isFile: boolean;
  children: TNode[];
};

/**
 * 统计指定 changelist 分组中的文件数量；未命中时返回 `0`。
 */
function resolveChangeListEntryCount(groups: ChangeEntryGroup[], changeListId: string): number {
  const hit = groups.find((group) => group.kind === "changelist" && String(group.changeListId || "").trim() === changeListId);
  return hit?.entries.length || 0;
}

/**
 * 比较两份展开态记录是否完全一致；若仅引用变化而语义未变，则允许直接复用旧对象。
 */
function isSameExpandedState(
  previousExpanded: Record<string, boolean>,
  nextExpanded: Record<string, boolean>,
): boolean {
  const previousKeys = Object.keys(previousExpanded);
  const nextKeys = Object.keys(nextExpanded);
  if (previousKeys.length !== nextKeys.length) return false;
  for (const key of nextKeys) {
    if (!Object.prototype.hasOwnProperty.call(previousExpanded, key)) return false;
    if (previousExpanded[key] !== nextExpanded[key]) return false;
  }
  return true;
}

/**
 * 判断旧状态里是否已有“非默认 changelist 被展开”的情况，用于参考上游默认展开策略。
 */
function hasExpandedNonDefaultChangeList(
  groups: ChangeEntryGroup[],
  expanded: Record<string, boolean>,
  defaultChangeListId: string,
): boolean {
  return groups.some((group) => (
    group.kind === "changelist"
    && String(group.changeListId || "").trim() !== defaultChangeListId
    && expanded[group.key] !== false
  ));
}

/**
 * 参考上游 `shouldExpandDefaultChangeList()` 的核心语义。
 */
export function shouldExpandDefaultChangeList(args: {
  previousGroups: ChangeEntryGroup[];
  nextGroups: ChangeEntryGroup[];
  previousExpanded: Record<string, boolean>;
  defaultChangeListId?: string;
}): boolean {
  const defaultChangeListId = String(args.defaultChangeListId || DEFAULT_COMMIT_PANEL_CHANGE_LIST_ID).trim() || DEFAULT_COMMIT_PANEL_CHANGE_LIST_ID;
  const previousDefaultCount = resolveChangeListEntryCount(args.previousGroups, defaultChangeListId);
  if (previousDefaultCount !== 0) return false;
  if (hasExpandedNonDefaultChangeList(args.previousGroups, args.previousExpanded, defaultChangeListId)) return false;
  return args.nextGroups.some((group) => group.kind === "changelist" && String(group.changeListId || "").trim() === defaultChangeListId);
}

/**
 * 按刷新前后分组与用户折叠状态，推导提交树新的分组展开态。
 */
export function resolveCommitGroupExpandedState(args: {
  previousGroups: ChangeEntryGroup[];
  nextGroups: ChangeEntryGroup[];
  previousExpanded: Record<string, boolean>;
  defaultChangeListId?: string;
  selectedNodeKeys?: string[];
}): Record<string, boolean> {
  const defaultChangeListId = String(args.defaultChangeListId || DEFAULT_COMMIT_PANEL_CHANGE_LIST_ID).trim() || DEFAULT_COMMIT_PANEL_CHANGE_LIST_ID;
  const shouldExpandDefault = shouldExpandDefaultChangeList({
    previousGroups: args.previousGroups,
    nextGroups: args.nextGroups,
    previousExpanded: args.previousExpanded,
    defaultChangeListId,
  });
  const nextExpanded: Record<string, boolean> = {};
  for (const group of args.nextGroups) {
    const isDefault = group.kind === "changelist" && String(group.changeListId || "").trim() === defaultChangeListId;
    if (shouldExpandDefault && isDefault) {
      nextExpanded[group.key] = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(args.previousExpanded, group.key)) {
      nextExpanded[group.key] = args.previousExpanded[group.key] !== false;
      continue;
    }
    nextExpanded[group.key] = shouldExpandDefault ? isDefault : true;
  }
  const selectedNodeKeySet = new Set(args.selectedNodeKeys || []);
  if (selectedNodeKeySet.size > 0) {
    for (const group of args.nextGroups) {
      if (group.entries.length === 0) continue;
      const hasSelectedNode = (group as CommitTreeGroup).treeRows?.some((row) => selectedNodeKeySet.has(row.node.key)) === true;
      if (hasSelectedNode) nextExpanded[group.key] = true;
    }
  }
  return isSameExpandedState(args.previousExpanded, nextExpanded) ? args.previousExpanded : nextExpanded;
}

/**
 * 为提交树补齐默认展开的目录节点；选区恢复时可展开祖先目录，普通状态同步需保留用户手动折叠。
 */
export function resolveCommitTreeExpandedState(args: {
  groups: CommitTreeGroup[];
  previousExpanded: Record<string, boolean>;
  selectedNodeKeys?: string[];
  expandSelectedNodeAncestors?: boolean;
}): Record<string, boolean> {
  let changed = false;
  const nextExpanded: Record<string, boolean> = { ...args.previousExpanded };
  const selectedNodeKeySet = args.expandSelectedNodeAncestors === false
    ? new Set<string>()
    : new Set(args.selectedNodeKeys || []);
  /**
   * 递归补齐默认展开节点；启用选区祖先修复时，命中已恢复选择的文件节点后展开其祖先目录。
   */
  const walk = (nodes: CommitTreeGroup["treeNodes"]): boolean => {
    let branchContainsSelected = false;
    for (const node of nodes) {
      if (node.isFile) {
        if (selectedNodeKeySet.has(node.key)) branchContainsSelected = true;
        continue;
      }
      if (!canCommitTreeNodeExpandSafely(node.fileCount || node.count || 0)) continue;
      if (!Object.prototype.hasOwnProperty.call(nextExpanded, node.key)) {
        nextExpanded[node.key] = true;
        changed = true;
      }
      const childContainsSelected = walk(node.children);
      if (childContainsSelected && nextExpanded[node.key] === false) {
        nextExpanded[node.key] = true;
        changed = true;
      }
      if (childContainsSelected) branchContainsSelected = true;
    }
    return branchContainsSelected;
  };
  for (const group of args.groups)
    walk(group.treeNodes);
  return changed ? nextExpanded : args.previousExpanded;
}

/**
 * 为任意目录树补齐默认展开态；若没有新增目录键，则复用旧对象以避免详情树进入重复渲染。
 */
export function resolveAutoExpandedDirectoryState<TNode extends AutoExpandTreeNode<TNode>>(args: {
  nodes: TNode[];
  previousExpanded: Record<string, boolean>;
}): Record<string, boolean> {
  let changed = false;
  const nextExpanded: Record<string, boolean> = { ...args.previousExpanded };
  /**
   * 递归登记所有目录节点，仅在首次出现时补默认展开，保留用户手动折叠状态。
   */
  const walk = (nodes: TNode[]): void => {
    for (const node of nodes) {
      if (node.isFile) continue;
      if (!Object.prototype.hasOwnProperty.call(nextExpanded, node.key)) {
        nextExpanded[node.key] = true;
        changed = true;
      }
      walk(node.children);
    }
  };
  walk(args.nodes);
  return changed ? nextExpanded : args.previousExpanded;
}

/**
 * 从树节点集合中提取首个文件节点键，供 merge conflict / partial inclusion / 最终兜底链路复用。
 */
function findFirstFileNodeKey(nodes: CommitTreeNode[]): string {
  for (const node of nodes) {
    if (node.isFile) return node.key;
    const childHit = findFirstFileNodeKey(node.children);
    if (childHit) return childHit;
  }
  return "";
}

/**
 * 按当前 inclusion 状态判断指定 changelist 是否处于“全集已纳入”状态，对齐 IDEA `setSelection()` 的 fully included 分支。
 */
function isCommitGroupFullyIncluded(
  group: CommitTreeGroup,
  inclusionState: CommitInclusionState,
): boolean {
  if (group.kind !== "changelist" || group.entries.length === 0) return false;
  const includedIds = new Set(inclusionState.includedIds);
  const itemIds = group.entries
    .filter((entry) => !entry.ignored)
    .map((entry) => buildCommitInclusionItemId(entry));
  if (itemIds.length === 0) return false;
  return itemIds.every((itemId) => includedIds.has(itemId));
}

/**
 * 从 inclusion 状态反向定位首个仍存在于当前树中的已纳入文件节点，用于 partial inclusion 的默认选中。
 */
function resolveFirstIncludedNodeKey(
  groups: CommitTreeGroup[],
  inclusionState: CommitInclusionState,
): string {
  const includedPathKeys = new Set(
    inclusionState.includedIds.flatMap((itemId) => {
      const item = inclusionState.itemsById[itemId];
      if (!item) return [];
      return [buildCommitInclusionLookupKey(
        `${item.changeListId || "default"}::${item.path.replace(/\\/g, "/")}::${item.conflictState || "normal"}`,
        item.repoRoot,
      )];
    }),
  );
  /**
   * 递归在完整节点树中查找首个已纳入文件，避免目录折叠时遗漏隐藏子节点。
   */
  const findInNodes = (nodes: CommitTreeNode[]): string => {
    for (const node of nodes) {
      if (node.entry) {
        const key = buildCommitInclusionLookupKey(
          `${node.entry.changeListId || "default"}::${node.entry.path.replace(/\\/g, "/")}::${node.entry.conflictState || "normal"}`,
          node.entry.repositoryRoot,
        );
        if (includedPathKeys.has(key)) return node.key;
      }
      const childHit = findInNodes(node.children);
      if (childHit) return childHit;
    }
    return "";
  };
  for (const group of groups) {
    const hit = findInNodes(group.treeNodes.length > 0 ? group.treeNodes : group.treeRows.map((row) => row.node));
    if (hit) return hit;
  }
  return "";
}

/**
 * 当刷新后原选择失效时，按 IDEA inclusion / merge conflict / default changelist 的顺序回落默认选中对象。
 */
export function resolveCommitFallbackRowSelection(args: {
  groups: CommitTreeGroup[];
  inclusionState?: CommitInclusionState;
  activeChangeListId?: string;
  defaultChangeListId?: string;
}): string[] {
  const groups = args.groups;
  const normalizedDefaultId = String(args.defaultChangeListId || args.activeChangeListId || DEFAULT_COMMIT_PANEL_CHANGE_LIST_ID).trim() || DEFAULT_COMMIT_PANEL_CHANGE_LIST_ID;
  const conflictNodeKey = groups
    .filter((group) => group.kind === "conflict")
    .map((group) => findFirstFileNodeKey(group.treeNodes.length > 0 ? group.treeNodes : group.treeRows.map((row) => row.node)))
    .find(Boolean);
  if (conflictNodeKey) return [`node:${conflictNodeKey}`];

  const resolvedConflictNodeKey = groups
    .filter((group) => group.kind === "resolved-conflict")
    .map((group) => findFirstFileNodeKey(group.treeNodes.length > 0 ? group.treeNodes : group.treeRows.map((row) => row.node)))
    .find(Boolean);
  if (resolvedConflictNodeKey) return [`node:${resolvedConflictNodeKey}`];

  if (args.inclusionState) {
    const activeGroup = groups.find((group) => group.kind === "changelist" && String(group.changeListId || "").trim() === normalizedDefaultId);
    if (activeGroup && isCommitGroupFullyIncluded(activeGroup, args.inclusionState) && activeGroup.showHeader !== false)
      return [`group:${activeGroup.key}`];

    const firstIncludedNodeKey = resolveFirstIncludedNodeKey(groups, args.inclusionState);
    if (firstIncludedNodeKey) return [`node:${firstIncludedNodeKey}`];
  }

  const defaultGroup = groups.find((group) => group.kind === "changelist" && String(group.changeListId || "").trim() === normalizedDefaultId);
  if (defaultGroup && defaultGroup.showHeader !== false) return [`group:${defaultGroup.key}`];
  const firstVisibleGroupKey = groups.find((group) => group.showHeader !== false)?.key;
  if (firstVisibleGroupKey) return [`group:${firstVisibleGroupKey}`];
  const firstVisibleNodeKey = groups
    .map((group) => findFirstFileNodeKey(group.treeNodes.length > 0 ? group.treeNodes : group.treeRows.map((row) => row.node)))
    .find(Boolean);
  return firstVisibleNodeKey ? [`node:${firstVisibleNodeKey}`] : [];
}

export type CommitTreeStateSnapshot = {
  selectedRowKeys: string[];
  expandedGroupKeys: string[];
  expandedNodeKeys: string[];
  scrollTop: number;
};

/**
 * 保存提交树最小状态快照，供刷新后按主树策略恢复展开态与选择态。
 */
export function createCommitTreeStateSnapshot(args: {
  selectedRowKeys: string[];
  groupExpanded: Record<string, boolean>;
  treeExpanded: Record<string, boolean>;
  scrollTop?: number;
}): CommitTreeStateSnapshot {
  return {
    selectedRowKeys: [...args.selectedRowKeys],
    expandedGroupKeys: Object.keys(args.groupExpanded).filter((key) => args.groupExpanded[key] !== false),
    expandedNodeKeys: Object.keys(args.treeExpanded).filter((key) => args.treeExpanded[key] !== false),
    scrollTop: Math.max(0, Math.floor(Number(args.scrollTop) || 0)),
  };
}
