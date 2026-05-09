// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitLocalChangesConfig, GitStatusEntry } from "../types";
import { isCommitAmendNode } from "./amend-model";
import { isEntryActionable } from "./inclusion-model";
import type { CommitPanelRenderRow, CommitSelectionAnchor, CommitSelectionContext, CommitTreeNode } from "./types";

const COMMIT_GROUP_ROW_PREFIX = "group:";
const COMMIT_NODE_ROW_PREFIX = "node:";

/**
 * 判断给定树行键是否表示提交树分组头，供选择恢复与右键逻辑统一复用。
 */
function isCommitGroupRowKey(rowKey: string): boolean {
  return String(rowKey || "").startsWith(COMMIT_GROUP_ROW_PREFIX);
}

/**
 * 判断给定树行键是否表示提交树节点行，避免多处散落字符串前缀判断。
 */
function isCommitNodeRowKey(rowKey: string): boolean {
  return String(rowKey || "").startsWith(COMMIT_NODE_ROW_PREFIX);
}

/**
 * 从 `node:*` 树行键中提取真实节点键；非节点行时返回空字符串。
 */
function resolveCommitNodeKeyFromRowKey(rowKey: string): string {
  return isCommitNodeRowKey(rowKey) ? String(rowKey).slice(COMMIT_NODE_ROW_PREFIX.length) : "";
}

/**
 * 归一化提交树使用的相对路径文本，避免选择恢复时受分隔符差异影响。
 */
function normalizeSelectionPath(pathText: string | undefined): string {
  return String(pathText || "").trim().replace(/\\/g, "/");
}

/**
 * 递归收集目录节点下的全部文件节点键，保持树中声明顺序，供 selected subtree 与 diffable 语义复用。
 */
function collectCommitSubtreeFileNodeKeys(nodes: CommitTreeNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.isFile) {
      out.push(node.key);
      continue;
    }
    out.push(...collectCommitSubtreeFileNodeKeys(node.children));
  }
  return out;
}

/**
 * 为当前可见提交树构建树行索引，供组头选择、恢复与上下文菜单命中统一复用。
 */
export function buildCommitRenderRowMap(rows: CommitPanelRenderRow[]): Map<string, CommitPanelRenderRow> {
  return new Map(rows.map((row) => [row.key, row] as const));
}

/**
 * 按“优先候选 + 当前选择”解析唯一可操作的 changelist ID；若不唯一则返回空字符串。
 */
export function resolveSingleChangeListId(
  preferredIds: Array<string | undefined>,
  selectedIds: string[],
  availableIds: Set<string>,
): string {
  for (const rawId of preferredIds) {
    const value = String(rawId || "").trim();
    if (value && availableIds.has(value)) return value;
  }
  const uniqueSelected = Array.from(new Set(
    selectedIds
      .map((one) => String(one || "").trim())
      .filter((one) => one && availableIds.has(one)),
  ));
  return uniqueSelected.length === 1 ? uniqueSelected[0] : "";
}

/**
 * 由已选树行推导真实文件路径集合；group/目录节点都会展开为其包含的文件。
 */
export function resolveSelectedChangePaths(
  selectedRowKeys: string[],
  rowMap: Map<string, CommitPanelRenderRow>,
  nodeMap: Map<string, CommitTreeNode>,
): string[] {
  const pathSet = new Set<string>();
  for (const rowKey of selectedRowKeys) {
    const row = rowMap.get(rowKey);
    if (row?.kind === "group") {
      for (const entry of row.group.entries) {
        const cleanPath = normalizeSelectionPath(entry.path);
        if (cleanPath) pathSet.add(cleanPath);
      }
      continue;
    }
    const node = nodeMap.get(resolveCommitNodeKeyFromRowKey(rowKey));
    if (!node) continue;
    for (const pathText of node.filePaths) {
      const cleanPath = normalizeSelectionPath(pathText);
      if (cleanPath) pathSet.add(cleanPath);
    }
  }
  return Array.from(pathSet);
}

/**
 * 仅提取真实树选区中“精确命中的文件节点”路径，不递归展开 group/目录，用于 exact selection 语义。
 */
export function resolveExactlySelectedChangePaths(
  selectedRowKeys: string[],
  nodeMap: Map<string, CommitTreeNode>,
): string[] {
  const pathSet = new Set<string>();
  for (const rowKey of selectedRowKeys) {
    const node = nodeMap.get(resolveCommitNodeKeyFromRowKey(rowKey));
    if (!node?.isFile || !node.entry) continue;
    const cleanPath = normalizeSelectionPath(node.entry.path);
    if (cleanPath) pathSet.add(cleanPath);
  }
  return Array.from(pathSet);
}

/**
 * 由已选树行推导相关 changelist 集合；group 选择会保留空 changelist 头本身的语义。
 */
export function resolveSelectedChangeListIds(
  selectedRowKeys: string[],
  rowMap: Map<string, CommitPanelRenderRow>,
  nodeMap: Map<string, CommitTreeNode>,
): string[] {
  const ids = new Set<string>();
  for (const rowKey of selectedRowKeys) {
    const row = rowMap.get(rowKey);
    if (row?.kind === "group") {
      const explicitId = String(row.group.changeListId || "").trim();
      if (explicitId) ids.add(explicitId);
      for (const entry of row.group.entries) {
        const changeListId = String(entry.changeListId || "").trim();
        if (changeListId) ids.add(changeListId);
      }
      continue;
    }
    const node = nodeMap.get(resolveCommitNodeKeyFromRowKey(rowKey));
    const changeListId = String(node?.entry?.changeListId || "").trim();
    if (changeListId) ids.add(changeListId);
  }
  return Array.from(ids);
}

/**
 * 仅提取“显式选中的 changelist 分组头”对应列表 ID，供删除更改列表这类严格依赖列表节点的动作复用。
 */
export function resolveExplicitSelectedChangeListIds(
  selectedRowKeys: string[],
  rowMap: Map<string, CommitPanelRenderRow>,
): string[] {
  const ids = new Set<string>();
  for (const rowKey of selectedRowKeys) {
    const row = rowMap.get(rowKey);
    if (row?.kind !== "group" || row.group.kind !== "changelist") continue;
    const changeListId = String(row.group.changeListId || "").trim();
    if (changeListId) ids.add(changeListId);
  }
  return Array.from(ids);
}

/**
 * 按当前真实树选择解析删除目标；目录节点保留目录路径，文件节点保留文件路径，分组头则回退为其包含文件。
 */
export function resolveSelectedDeleteTargets(
  selectedRowKeys: string[],
  rowMap: Map<string, CommitPanelRenderRow>,
  nodeMap: Map<string, CommitTreeNode>,
): string[] {
  const out = new Set<string>();
  for (const rowKey of selectedRowKeys) {
    const row = rowMap.get(rowKey);
    if (row?.kind === "group") {
      for (const entry of row.group.entries) {
        const cleanPath = normalizeSelectionPath(entry.path);
        if (cleanPath) out.add(cleanPath);
      }
      continue;
    }
    const node = nodeMap.get(resolveCommitNodeKeyFromRowKey(rowKey));
    if (!node) continue;
    if (node.isFile && node.entry) {
      const cleanPath = normalizeSelectionPath(node.entry.path);
      if (cleanPath) out.add(cleanPath);
      continue;
    }
    const directoryPath = normalizeSelectionPath(node.fullPath);
    if (directoryPath) out.add(directoryPath);
  }
  return Array.from(out);
}

/**
 * 从当前树行选择推导真实节点选择；group 行不会隐式展开为子节点，避免破坏“真实树选择对象”语义。
 */
export function resolveSelectedCommitNodeKeys(
  selectedRowKeys: string[],
  nodeMap: Map<string, CommitTreeNode>,
): string[] {
  return filterSelectableCommitNodeKeys(
    selectedRowKeys.map((rowKey) => resolveCommitNodeKeyFromRowKey(rowKey)).filter(Boolean),
    nodeMap,
  );
}

/**
 * 按 selected subtree 语义把真实树选区展开为文件节点集合；group/目录都会递归展开到其子文件。
 */
export function resolveSelectedSubtreeCommitNodeKeys(
  selectedRowKeys: string[],
  rowMap: Map<string, CommitPanelRenderRow>,
  nodeMap: Map<string, CommitTreeNode>,
): string[] {
  const out: string[] = [];
  for (const rowKey of selectedRowKeys) {
    const row = rowMap.get(rowKey);
    if (row?.kind === "group") {
      out.push(...collectCommitSubtreeFileNodeKeys(row.group.treeNodes));
      continue;
    }
    const node = nodeMap.get(resolveCommitNodeKeyFromRowKey(rowKey));
    if (!node) continue;
    if (node.isFile) {
      out.push(node.key);
      continue;
    }
    out.push(...collectCommitSubtreeFileNodeKeys(node.children));
  }
  return filterSelectableCommitNodeKeys(out, nodeMap);
}

export type CommitMenuSelectionSnapshot = {
  selectedRowKeys: string[];
  selectedNodeKeys: string[];
  selectedSubtreeNodeKeys: string[];
  selectedEntries: GitStatusEntry[];
  selectedPaths: string[];
  exactlySelectedPaths: string[];
  selectedDeleteTargets: string[];
  selectedChangeListIds: string[];
  selectedExplicitChangeListIds: string[];
  selectedNodeSources: Array<{ sourceKind?: "status" | "modifier"; sourceId?: string }>;
  selectedSingleNode: CommitTreeNode | null;
};

/**
 * 基于显式树行键生成一次性菜单选择快照。
 * - 对齐 IDEA `uiDataSnapshot(DataSink)` 的语义：弹出菜单后动作应读取“打开菜单当下”的选择，而不是后续漂移的全局状态。
 * - 同时收敛 selected entries / paths / delete targets / changelist ids，避免右键动作各自重复推导。
 */
export function buildCommitMenuSelectionSnapshot(args: {
  selectedRowKeys: string[];
  rowMap: Map<string, CommitPanelRenderRow>;
  nodeMap: Map<string, CommitTreeNode>;
}): CommitMenuSelectionSnapshot {
  const selectedRowKeys = filterSelectableCommitRowKeys(args.selectedRowKeys, args.rowMap, args.nodeMap);
  const selectedNodeKeys = resolveSelectedCommitNodeKeys(selectedRowKeys, args.nodeMap);
  const selectedSubtreeNodeKeys = resolveSelectedSubtreeCommitNodeKeys(selectedRowKeys, args.rowMap, args.nodeMap);
  const selectedEntries = selectedSubtreeNodeKeys
    .map((nodeKey) => args.nodeMap.get(nodeKey)?.entry || null)
    .filter((entry): entry is GitStatusEntry => !!entry);
  const selectedNodeSources = Array.from(new Map(
    selectedSubtreeNodeKeys
      .map((nodeKey) => args.nodeMap.get(nodeKey))
      .filter((node): node is CommitTreeNode => !!node)
      .map((node) => {
        const sourceKind = node.sourceKind;
        const sourceId = node.sourceId;
        return [`${String(sourceKind || "")}:${String(sourceId || "")}`, { sourceKind, sourceId }] as const;
      }),
  ).values());
  return {
    selectedRowKeys,
    selectedNodeKeys,
    selectedSubtreeNodeKeys,
    selectedEntries,
    selectedPaths: resolveSelectedChangePaths(selectedRowKeys, args.rowMap, args.nodeMap),
    exactlySelectedPaths: resolveExactlySelectedChangePaths(selectedRowKeys, args.nodeMap),
    selectedDeleteTargets: resolveSelectedDeleteTargets(selectedRowKeys, args.rowMap, args.nodeMap),
    selectedChangeListIds: resolveSelectedChangeListIds(selectedRowKeys, args.rowMap, args.nodeMap),
    selectedExplicitChangeListIds: resolveExplicitSelectedChangeListIds(selectedRowKeys, args.rowMap),
    selectedNodeSources,
    selectedSingleNode: selectedNodeKeys.length === 1 ? (args.nodeMap.get(selectedNodeKeys[0]) || null) : null,
  };
}

/**
 * 按 IDEA selectedDiffableNode 语义解析当前 diffable 文件节点；若旧 diffable 仍落在选中子树内，则优先保留。
 */
export function resolveSelectedDiffableCommitNodeKey(args: {
  selectedRowKeys: string[];
  rowMap: Map<string, CommitPanelRenderRow>;
  nodeMap: Map<string, CommitTreeNode>;
  previousNodeKey?: string;
}): string {
  const subtreeNodeKeys = resolveSelectedSubtreeCommitNodeKeys(args.selectedRowKeys, args.rowMap, args.nodeMap).filter((nodeKey) => {
    const node = args.nodeMap.get(nodeKey);
    return !!node?.entry && !node.entry.ignored;
  });
  if (subtreeNodeKeys.length === 0) return "";
  const previousNodeKey = String(args.previousNodeKey || "").trim();
  if (previousNodeKey && subtreeNodeKeys.includes(previousNodeKey)) return previousNodeKey;
  return subtreeNodeKeys[0] || "";
}

/**
 * 根据当前树行选择生成恢复锚点；group 头与节点行分别保存各自的稳定身份信息。
 */
export function buildCommitSelectionAnchors(
  selectedRowKeys: string[],
  rowMap: Map<string, CommitPanelRenderRow>,
  nodeMap: Map<string, CommitTreeNode>,
): CommitSelectionAnchor[] {
  const anchors: CommitSelectionAnchor[] = [];
  for (const rowKey of selectedRowKeys) {
    const row = rowMap.get(rowKey);
    if (row?.kind === "group") {
      anchors.push({
        kind: "group",
        rowKey: row.key,
        changeListId: String(row.group.changeListId || "").trim() || undefined,
        groupStableId: String(row.group.stableId || row.group.key || "").trim() || undefined,
      });
      continue;
    }
    const node = nodeMap.get(resolveCommitNodeKeyFromRowKey(rowKey));
    if (!node) continue;
    if (node.isFile && node.entry) {
      anchors.push({
        kind: "node",
        path: node.entry.path,
        changeListId: node.entry.changeListId || undefined,
        rowKey: `${COMMIT_NODE_ROW_PREFIX}${node.key}`,
        stableId: node.stableId,
      });
      continue;
    }
    const firstPath = node.filePaths[0];
    if (!firstPath && !node.stableId) continue;
    anchors.push({
      kind: "node",
      path: firstPath,
      rowKey: `${COMMIT_NODE_ROW_PREFIX}${node.key}`,
      stableId: node.stableId,
    });
  }
  return anchors;
}

/**
 * 按锚点恢复提交树选择；group 头直接按稳定 ID 命中，节点仍优先按 stable identity + changelist + path 恢复。
 */
export function restoreCommitTreeSelection(
  anchors: CommitSelectionAnchor[],
  rowMap: Map<string, CommitPanelRenderRow>,
  nodeMap: Map<string, CommitTreeNode>,
): string[] {
  if (anchors.length === 0) return [];
  const groupByStableId = new Map<string, string>();
  for (const row of rowMap.values()) {
    if (row.kind !== "group") continue;
    const stableId = String(row.group.stableId || row.group.key || "").trim();
    if (stableId) groupByStableId.set(stableId, row.key);
  }
  const byStableId = new Map<string, CommitTreeNode>();
  const byPath = new Map<string, CommitTreeNode[]>();
  for (const node of nodeMap.values()) {
    const stableId = String(node.stableId || "").trim();
    if (stableId) byStableId.set(stableId, node);
    if (!node.isFile || !node.entry) continue;
    const pathText = normalizeSelectionPath(node.entry.path);
    if (!byPath.has(pathText)) byPath.set(pathText, []);
    byPath.get(pathText)?.push(node);
  }
  const restored: string[] = [];
  for (const anchor of anchors) {
    if (anchor.kind === "group") {
      const exactRow = anchor.rowKey && rowMap.has(anchor.rowKey) ? anchor.rowKey : "";
      const stableRow = anchor.groupStableId ? groupByStableId.get(anchor.groupStableId) || "" : "";
      const hit = exactRow || stableRow;
      if (hit) restored.push(hit);
      continue;
    }
    const exactStable = anchor.stableId ? byStableId.get(anchor.stableId) : undefined;
    if (exactStable) {
      restored.push(`${COMMIT_NODE_ROW_PREFIX}${exactStable.key}`);
      continue;
    }
    const matches = byPath.get(normalizeSelectionPath(anchor.path)) || [];
    const exact = anchor.changeListId
      ? matches.find((node) => String(node.entry?.changeListId || "") === anchor.changeListId)
      : undefined;
    const fallbackNodeKey = resolveCommitNodeKeyFromRowKey(String(anchor.rowKey || ""));
    const hit = exact || matches[0] || (fallbackNodeKey && nodeMap.has(fallbackNodeKey) ? nodeMap.get(fallbackNodeKey) : undefined);
    if (hit) restored.push(`${COMMIT_NODE_ROW_PREFIX}${hit.key}`);
  }
  return Array.from(new Set(restored));
}

/**
 * 过滤不可选树行，确保 group 头与节点行都遵守统一的选择能力判定。
 */
export function filterSelectableCommitRowKeys(
  rowKeys: string[],
  rowMap: Map<string, CommitPanelRenderRow>,
  nodeMap: Map<string, CommitTreeNode>,
): string[] {
  return Array.from(new Set(
    rowKeys.filter((rowKey) => {
      if (isCommitGroupRowKey(rowKey)) return rowMap.has(rowKey);
      const node = nodeMap.get(resolveCommitNodeKeyFromRowKey(rowKey));
      if (!node) return false;
      if (node.selectionFlags?.nonSelectable) return false;
      return node.selectionFlags?.selectable !== false;
    }),
  ));
}

/**
 * 过滤不可选节点，确保鼠标、多选、程序化恢复与 Select In 都遵守 `NON_SELECTABLE` 语义。
 */
export function filterSelectableCommitNodeKeys(nodeKeys: string[], nodeMap: Map<string, CommitTreeNode>): string[] {
  return Array.from(new Set(
    nodeKeys.filter((nodeKey) => {
      const node = nodeMap.get(nodeKey);
      if (!node) return false;
      if (node.selectionFlags?.nonSelectable) return false;
      return node.selectionFlags?.selectable !== false;
    }),
  ));
}

/**
 * 基于统一 selection data model 计算变更菜单启用态，避免 UI 自行猜测。
 */
export function deriveCommitSelectionContext(args: {
  selectedEntries: GitStatusEntry[];
  selectedPaths: string[];
  exactlySelectedPaths?: string[];
  selectedNodeSources?: Array<Pick<CommitTreeNode, "sourceKind" | "sourceId">>;
  selectedChangeListIds: string[];
  selectedExplicitChangeListIds?: string[];
  contextChangeListId?: string;
  contextChangeListExplicit?: boolean;
  availableChangeListIds: Set<string>;
  activeChangeListId: string;
  localChangesConfig: GitLocalChangesConfig;
  stashPushPathspecSupported?: boolean;
}): CommitSelectionContext {
  const targetChangeListId = resolveSingleChangeListId([args.contextChangeListId], args.selectedChangeListIds, args.availableChangeListIds);
  const explicitChangeListIds = Array.from(new Set(
    [
      ...(args.selectedExplicitChangeListIds || []),
      args.contextChangeListExplicit ? args.contextChangeListId : "",
    ]
      .map((one) => String(one || "").trim())
      .filter((one) => one && args.availableChangeListIds.has(one)),
  ));
  const removableChangeListIds = Array.from(new Set(
    explicitChangeListIds,
  ));
  const changeListsEnabled = args.localChangesConfig.changeListsEnabled && !args.localChangesConfig.stagingAreaEnabled;
  const actionableEntries = args.selectedEntries.filter((entry) => isEntryActionable(entry));
  const selectedUnversionedEntries = args.selectedEntries.filter((entry) => entry.untracked && !entry.ignored);
  const selectedIgnoredEntries = args.selectedEntries.filter((entry) => entry.ignored);
  const selectedStageableEntries = args.selectedEntries.filter((entry) => entry.unstaged || entry.untracked || entry.ignored);
  const selectedTrackedUnstagedEntries = args.selectedEntries.filter((entry) => entry.unstaged && !entry.untracked && !entry.ignored);
  const selectedStagedEntries = args.selectedEntries.filter((entry) => entry.staged);
  const selectedStashableEntries = args.selectedEntries.filter((entry) => !entry.ignored && (entry.staged || entry.unstaged || entry.untracked));
  const canAddToVcs = args.selectedEntries.some((entry) => entry.untracked || entry.ignored);
  const exactlySelectedFiles = Array.from(new Set((args.exactlySelectedPaths || []).filter(Boolean)));
  const selectedVirtualPaths = Array.from(new Set(args.selectedPaths.filter(Boolean)));
  const selectedStageablePaths = Array.from(new Set(selectedStageableEntries.map((entry) => entry.path)));
  const selectedTrackedUnstagedPaths = Array.from(new Set(selectedTrackedUnstagedEntries.map((entry) => entry.path)));
  const selectedStagedPaths = Array.from(new Set(selectedStagedEntries.map((entry) => entry.path)));
  const selectedStashablePaths = Array.from(new Set(selectedStashableEntries.map((entry) => entry.path)));
  const selectedNodeSources = Array.from(new Map(
    (args.selectedNodeSources || [])
      .filter((source) => !!source)
      .map((source) => {
        const sourceKind = String(source.sourceKind || "").trim();
        const sourceId = String(source.sourceId || "").trim();
        return [`${sourceKind}:${sourceId}`, { sourceKind, sourceId }] as const;
      }),
  ).values());
  const amendOnlySelection = selectedNodeSources.length > 0 && selectedNodeSources.every((source) => isCommitAmendNode(source));
  const referenceOnlySelection = (
    args.selectedEntries.length > 0
    && args.selectedEntries.every((entry) => !entry.staged && !entry.unstaged && !entry.untracked && !entry.ignored)
  );
  /**
   * amend helper 节点在 IDEA 里仍复用共享右键菜单；虽然它不是当前工作区状态条目，
   * 但提交 / 回滚 / 搁置等动作的可用性不应被 reference-only 规则整体拦截。
   */
  const amendSharedPopupSelection = amendOnlySelection && actionableEntries.length > 0;
  const localMutationBlockedSelection = amendOnlySelection || referenceOnlySelection;
  const singleSelectedEntry = args.selectedEntries.length === 1 && selectedVirtualPaths.length === 1
    ? args.selectedEntries[0]
    : null;
  const canShowLocal = !localMutationBlockedSelection && !!singleSelectedEntry && !singleSelectedEntry.ignored && !singleSelectedEntry.deleted;
  const canCompareWithStaged = !localMutationBlockedSelection && canShowLocal && !!singleSelectedEntry?.staged;
  const canCompareWithHead = !localMutationBlockedSelection && !!singleSelectedEntry?.staged && !singleSelectedEntry.untracked && !singleSelectedEntry.ignored;
  const canShowHistory = referenceOnlySelection
    ? selectedVirtualPaths.length === 1
    : amendOnlySelection
      ? selectedVirtualPaths.length > 0
      : actionableEntries.length === 1;

  return {
    selectedEntries: args.selectedEntries,
    selectedChanges: actionableEntries,
    selectedPaths: args.selectedPaths,
    selectedUnversionedPaths: selectedUnversionedEntries.map((entry) => entry.path),
    selectedIgnoredPaths: selectedIgnoredEntries.map((entry) => entry.path),
    selectedStageablePaths,
    selectedTrackedUnstagedPaths,
    selectedStagedPaths,
    selectedStashablePaths,
    selectedChangeListIds: args.selectedChangeListIds,
    exactlySelectedFiles,
    virtualFilePaths: selectedVirtualPaths,
    navigatablePaths: selectedVirtualPaths,
    leadSelectionPath: exactlySelectedFiles[0] || selectedVirtualPaths[0],
    helpId: "git.commit.tree",
    targetChangeListId,
    removableChangeListIds,
    canEditList: changeListsEnabled && !!targetChangeListId,
    canDeleteList: changeListsEnabled && removableChangeListIds.length > 0,
    canSetActiveList: changeListsEnabled && !!targetChangeListId && targetChangeListId !== args.activeChangeListId,
    canMoveToList: changeListsEnabled && (args.selectedEntries.length > 0 || selectedVirtualPaths.length > 0),
    canAddToVcs: !localMutationBlockedSelection && canAddToVcs,
    canStage: !localMutationBlockedSelection && selectedStageablePaths.length > 0,
    canStageWithoutContent: !localMutationBlockedSelection && selectedUnversionedEntries.length > 0,
    canUnstage: !localMutationBlockedSelection && selectedStagedPaths.length > 0,
    canRevertUnstaged: !localMutationBlockedSelection && selectedTrackedUnstagedPaths.length > 0,
    canStageStash: !localMutationBlockedSelection && args.localChangesConfig.stagingAreaEnabled && args.stashPushPathspecSupported !== false && selectedStashablePaths.length > 0,
    canIgnore: !localMutationBlockedSelection && selectedUnversionedEntries.length > 0,
    canCommit: amendSharedPopupSelection || (!referenceOnlySelection && actionableEntries.length > 0),
    canRollback: amendSharedPopupSelection || (!referenceOnlySelection && actionableEntries.length > 0),
    canShelve: amendSharedPopupSelection || (!localMutationBlockedSelection && selectedStashablePaths.length > 0),
    canShowDiff: actionableEntries.length > 0,
    canShowStaged: !localMutationBlockedSelection && !!singleSelectedEntry?.staged,
    canShowLocal,
    canCompareLocalToStaged: canCompareWithStaged,
    canCompareStagedToLocal: canCompareWithStaged,
    canCompareStagedToHead: canCompareWithHead,
    canCompareThreeVersions: canCompareWithHead && canShowLocal,
    canOpenSource: args.selectedPaths.length === 1,
    canDelete: actionableEntries.length > 0,
    canShowHistory,
    changeListsEnabled,
    stagingAreaEnabled: args.localChangesConfig.stagingAreaEnabled,
  };
}

export type CommitDiffSelection = {
  primaryPath: string;
  paths: string[];
  kind: "change" | "unversioned" | "mixed";
};

/**
 * 按 IDEA diffable selection 语义为单选/多选结果构建可导航文件集合。
 */
export function buildCommitDiffSelection(args: {
  selectedEntries: GitStatusEntry[];
  allEntries: GitStatusEntry[];
}): CommitDiffSelection | null {
  const selectedEntries = args.selectedEntries.filter((entry) => !entry.ignored);
  if (selectedEntries.length === 0) return null;
  if (selectedEntries.length === 1) {
    const selected = selectedEntries[0];
    if (selected.untracked) {
      const paths = Array.from(new Set(
        args.allEntries
          .filter((entry) => entry.untracked && !entry.ignored)
          .map((entry) => entry.path),
      ));
      return {
        primaryPath: selected.path,
        paths,
        kind: "unversioned",
      };
    }
    const sameListPaths = Array.from(new Set(
      args.allEntries
        .filter((entry) => !entry.untracked && !entry.ignored && String(entry.changeListId || "") === String(selected.changeListId || ""))
        .map((entry) => entry.path),
    ));
    return {
      primaryPath: selected.path,
      paths: sameListPaths.length > 0 ? sameListPaths : [selected.path],
      kind: "change",
    };
  }
  return {
    primaryPath: selectedEntries[0].path,
    paths: Array.from(new Set(selectedEntries.map((entry) => entry.path))),
    kind: "mixed",
  };
}

/**
 * 按树节点来源构建真正的 diffable selection；单选 changelist / amend / unversioned 时会扩展到同来源整组文件。
 */
export function buildCommitDiffSelectionFromNodes(args: {
  selectedNodeKeys: string[];
  nodeMap: Map<string, CommitTreeNode>;
}): CommitDiffSelection | null {
  const selectedNodes = filterSelectableCommitNodeKeys(args.selectedNodeKeys, args.nodeMap)
    .map((nodeKey) => args.nodeMap.get(nodeKey))
    .filter((node): node is CommitTreeNode => !!node && node.isFile && !!node.entry && !node.entry.ignored);
  if (selectedNodes.length === 0) return null;

  if (selectedNodes.length === 1) {
    const selectedNode = selectedNodes[0];
    const selectedEntry = selectedNode.entry!;
    const comparableNodes = Array.from(args.nodeMap.values()).filter((node) => (
      node.isFile
      && !!node.entry
      && !node.entry.ignored
      && String(node.sourceGroupKey || "") === String(selectedNode.sourceGroupKey || "")
      && String(node.sourceId || "") === String(selectedNode.sourceId || "")
    ));
    const paths = Array.from(new Set(
      comparableNodes.length > 0
        ? comparableNodes.map((node) => String(node.entry?.path || "").trim()).filter(Boolean)
        : [selectedEntry.path],
    ));
    return {
      primaryPath: selectedEntry.path,
      paths,
      kind: selectedEntry.untracked ? "unversioned" : "change",
    };
  }

  return {
    primaryPath: selectedNodes[0].entry!.path,
    paths: Array.from(new Set(selectedNodes.map((node) => String(node.entry?.path || "").trim()).filter(Boolean))),
    kind: "mixed",
  };
}

/**
 * 按给定路径在当前树中反向定位节点；优先命中同 changelist，再回退到同路径第一个节点。
 */
export function selectCommitNodeByPath(args: {
  path: string;
  nodeMap: Map<string, CommitTreeNode>;
  preferredChangeListId?: string;
}): string[] {
  const targetPath = String(args.path || "").trim().replace(/\\/g, "/");
  if (!targetPath) return [];
  const matches = Array.from(args.nodeMap.values()).filter((node) => (
    node.isFile
    && String(node.entry?.path || "").replace(/\\/g, "/") === targetPath
  ));
  if (matches.length === 0) return [];
  const exact = args.preferredChangeListId
    ? matches.find((node) => String(node.entry?.changeListId || "") === String(args.preferredChangeListId || ""))
    : undefined;
  return filterSelectableCommitNodeKeys([String((exact || matches[0])?.key || "")].filter(Boolean), args.nodeMap);
}
