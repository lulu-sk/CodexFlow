// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, Folder, Loader2, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { interpolateI18nText } from "@/lib/translate";
import { cn } from "@/lib/utils";
import type { GitLocalChangesConfig, GitStatusEntry } from "../types";
import { useVirtualWindow } from "../use-virtual-window";
import {
  buildCommitPanelRenderRows,
  formatCommitTreeGroupSummary,
  getCommitGroupTextPresentation,
  getCommitNodeTextPresentation,
} from "./changes-tree-view-model";
import {
  buildCommitInclusionItemId,
  getCommitInclusionCheckState,
  isCommitGroupInclusionVisible,
  isCommitNodeInclusionVisible,
  normalizeCommitRepoRoot,
} from "./inclusion-model";
import { COMMIT_TREE_ROW_HEIGHT } from "./config";
import {
  buildCommitTreeCopyText,
  findCommitSpeedSearchMatch,
  findCommitSpeedSearchRanges,
  navigateCommitTreeRows,
} from "./tree-interactions";
import type { CommitInclusionState, CommitPanelRenderRow, CommitTreeGroup, CommitTreeNode, CommitTreeNodeAction } from "./types";
const COMMIT_TREE_BASE_PADDING = 30;
const TREE_DEPTH_INDENT = 18;
const COMMIT_TREE_OVERSCAN = 10;

type CommitTreeDragPayload = {
  sourceComponent: "commit-tree";
  entries: GitStatusEntry[];
};

type CommitTreePaneProps = {
  groups: CommitTreeGroup[];
  inclusionState: CommitInclusionState;
  statusEntryByPath: Map<string, GitStatusEntry>;
  statusEntriesByPath: Map<string, GitStatusEntry[]>;
  selectedRowKeys: string[];
  selectedPaths: string[];
  groupExpanded: Record<string, boolean>;
  treeExpanded: Record<string, boolean>;
  localChangesConfig: GitLocalChangesConfig;
  activeChangeListId: string;
  selectedDiffableEntry?: GitStatusEntry | null;
  ignoredLoading: boolean;
  busy?: boolean;
  containerRef: React.RefObject<HTMLDivElement>;
  onActivate: () => void;
  onSelectRow: (rowKey: string, event: React.MouseEvent<HTMLDivElement>) => void;
  onApplyTreeSelection: (rowKeys: string[]) => void;
  onInvokeEntryAction: (entry: GitStatusEntry, intent: "doubleClick" | "f4" | "enter" | "singleClick") => void;
  onInvokeHoverAction: (node: CommitTreeNode, action: CommitTreeNodeAction) => void;
  onResolveConflictGroup: (group: CommitTreeGroup) => void;
  onBrowseGroup: (group: CommitTreeGroup) => void;
  onIgnorePaths: (paths: string[], anchor?: { x: number; y: number }) => void;
  onPerformStageOperation: (entries: GitStatusEntry[], action: "stage" | "unstage") => Promise<void>;
  onToggleGroupExpanded: (groupKey: string) => void;
  onToggleTreeExpanded: (nodeKey: string) => void;
  onToggleInclusion: (itemIds: string[], included: boolean, repoRoots?: string[]) => void;
  onOpenContextMenu: (
    event: React.MouseEvent,
    target: string,
    targetKind?: "file" | "folder" | "changelist",
    changeListId?: string,
    selectionRowKeys?: string[],
  ) => void;
  onMoveFilesToChangeList: (paths: string[], targetListId: string) => Promise<void>;
  resolveStatusToneClassName: (statusRaw: string) => string;
};

/**
 * 推导分组所对应的唯一 changelist ID；空 changelist 优先使用显式 group.changeListId。
 */
function resolveGroupChangeListId(group: CommitTreeGroup): string {
  const explicitId = String(group.changeListId || "").trim();
  if (explicitId) return explicitId;
  const groupedIds = Array.from(new Set(
    group.entries
      .map((entry) => String(entry.changeListId || "").trim())
      .filter(Boolean),
  ));
  return groupedIds.length === 1 ? groupedIds[0] : "";
}

/**
 * 从路径索引中解析当前节点真实关联的状态条目，优先按 repository/module 元数据收敛多仓同路径歧义。
 */
function resolveNodeEntries(
  node: CommitTreeNode,
  statusEntriesByPath: Map<string, GitStatusEntry[]>,
): GitStatusEntry[] {
  if (node.entry) return [node.entry];
  const out: GitStatusEntry[] = [];
  const seen = new Set<string>();
  for (const one of node.filePaths) {
    const pathKey = String(one || "").replace(/\\/g, "/");
    const candidates = statusEntriesByPath.get(pathKey) || [];
    for (const candidate of candidates) {
      if (node.repositoryId && candidate.repositoryId && node.repositoryId !== candidate.repositoryId) continue;
      if (node.moduleId && candidate.moduleId && node.moduleId !== candidate.moduleId) continue;
      const itemId = buildCommitInclusionItemId(candidate);
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      out.push(candidate);
    }
  }
  return out;
}

/**
 * 根据目录/文件节点关联的条目集合，提取可参与 inclusion 的 item ID。
 */
function resolveNodeItemIds(
  node: CommitTreeNode,
  statusEntriesByPath: Map<string, GitStatusEntry[]>,
): string[] {
  return resolveNodeEntries(node, statusEntriesByPath)
    .filter((entry) => !entry.ignored)
    .map((entry) => buildCommitInclusionItemId(entry));
}

/**
 * 从分组头提取可参与 inclusion 的 item ID 集合，供 checkbox、Space 与上下文动作统一复用。
 */
function resolveGroupItemIds(group: CommitTreeGroup): string[] {
  return group.entries
    .filter((entry) => !entry.ignored)
    .map((entry) => buildCommitInclusionItemId(entry));
}

/**
 * 从状态条目里提取仓库根集合，供 root inclusion 状态跟随树上交互一起更新。
 */
function resolveEntryRepoRoots(entries: GitStatusEntry[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const repoRoot = normalizeCommitRepoRoot(entry.repositoryRoot);
    if (!repoRoot || seen.has(repoRoot)) continue;
    seen.add(repoRoot);
    out.push(repoRoot);
  }
  return out;
}

/**
 * 从鼠标事件中提取可用的 popup 锚点；测试环境或无坐标场景返回空值，避免传出无意义对象。
 */
function resolvePointerAnchor(event: Pick<MouseEvent, "clientX" | "clientY">): { x: number; y: number } | undefined {
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return undefined;
  return {
    x: Math.floor(event.clientX),
    y: Math.floor(event.clientY),
  };
}

/**
 * 按状态条目集合构建显式拖拽载荷，并用 inclusion item id 去重，避免多选父子节点时重复投放。
 */
function buildDragPayload(entries: GitStatusEntry[]): CommitTreeDragPayload | null {
  const out: GitStatusEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const itemId = buildCommitInclusionItemId(entry);
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);
    out.push(entry);
  }
  if (out.length === 0) return null;
  return {
    sourceComponent: "commit-tree",
    entries: out,
  };
}

/**
 * 从拖拽载荷中按 tracked / unversioned / ignored 三类提取唯一路径，复用到 ignored 与 changelist 投放分支。
 */
function resolveDragPayloadPaths(payload: CommitTreeDragPayload, kind: "change" | "unversioned" | "ignored"): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of payload.entries) {
    const matches = kind === "ignored"
      ? entry.ignored
      : kind === "unversioned"
        ? entry.untracked && !entry.ignored
        : !entry.ignored && !entry.untracked;
    if (!matches) continue;
    const path = String(entry.path || "").replace(/\\/g, "/");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * 对齐 IDEA `GitAddOperation.matches`，仅允许未暂存或未跟踪条目投放到 staged 分组。
 */
function canStageDraggedEntry(entry: GitStatusEntry): boolean {
  return !entry.ignored && (entry.untracked || entry.unstaged || !entry.staged);
}

/**
 * 对齐 IDEA `GitResetOperation.matches`，仅允许已暂存条目投放到 unstaged 分组。
 */
function canUnstageDraggedEntry(entry: GitStatusEntry): boolean {
  return !entry.ignored && entry.staged;
}

/**
 * 把单个树行还原为真实状态条目集合，供拖拽与后续 stage/reset 操作共享。
 */
function resolveRowEntriesForDrag(
  row: CommitPanelRenderRow,
  statusEntriesByPath: Map<string, GitStatusEntry[]>,
): GitStatusEntry[] {
  return row.kind === "group" ? row.group.entries : resolveNodeEntries(row.node, statusEntriesByPath);
}

/**
 * 当当前行已在选区中时，拖拽应提升为“整组选区”语义，而不是只拖动当前行。
 */
function resolveSelectedDragEntries(
  selectedRowKeys: string[],
  renderRows: CommitPanelRenderRow[],
  statusEntriesByPath: Map<string, GitStatusEntry[]>,
): GitStatusEntry[] {
  const out: GitStatusEntry[] = [];
  for (const rowKey of selectedRowKeys) {
    const row = renderRows.find((one) => one.key === rowKey);
    if (!row) continue;
    out.push(...resolveRowEntriesForDrag(row, statusEntriesByPath));
  }
  return out;
}

/**
 * 根据当前树行生成父节点定位函数，供 ArrowLeft 导航回到最近可见父节点。
 */
function buildParentRowResolver(rows: CommitPanelRenderRow[]): (rowKey: string) => string {
  const depthByKey = new Map(rows.map((row) => [row.key, row.kind === "node" ? row.depth : -1] as const));
  return (rowKey: string): string => {
    const currentIndex = rows.findIndex((row) => row.key === rowKey);
    const currentDepth = depthByKey.get(rowKey);
    if (currentIndex <= 0 || currentDepth == null) return rowKey;
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const candidate = rows[index];
      if (candidate.kind === "group") return candidate.key;
      if (candidate.depth < currentDepth) return candidate.key;
    }
    return rowKey;
  };
}

/**
 * 根据右键命中的树行决定是否保留现有选择，避免在已选区域上打开菜单时无意义打散选择。
 */
function resolveContextSelectionRowKeys(args: {
  row: CommitPanelRenderRow;
  selectedRowKeys: string[];
}): string[] {
  return args.selectedRowKeys.includes(args.row.key) ? args.selectedRowKeys : [args.row.key];
}

/**
 * 仅当提交树处于单选且命中当前节点时，才允许触发节点级 openHandler，对齐 IDEA 的 `selected(...).single()` 语义。
 */
function canInvokeNodeOpenHandler(rowKey: string, selectedRowKeys: string[]): boolean {
  return selectedRowKeys.length === 1 && selectedRowKeys[0] === rowKey;
}

/**
 * 把 speed search 命中的文本片段渲染为高亮节点；未命中时保持原始文本，避免额外 DOM 噪音。
 */
function renderSpeedSearchText(text: string, query: string): React.ReactNode {
  const ranges = findCommitSpeedSearchRanges({ text, query });
  if (!ranges || ranges.length <= 0) return text;
  const fragments: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) {
      fragments.push(<React.Fragment key={`plain:${index}:${cursor}`}>{text.slice(cursor, range.start)}</React.Fragment>);
    }
    fragments.push(
      <span
        key={`match:${index}:${range.start}`}
        className="cf-git-speed-search-hit rounded-[3px] bg-[var(--cf-yellow)] px-[2px] font-apple-medium text-[var(--cf-warning-foreground)] shadow-[inset_0_0_0_1px_rgba(120,76,0,0.28)]"
      >
        {text.slice(range.start, range.end)}
      </span>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) {
    fragments.push(<React.Fragment key={`plain:tail:${cursor}`}>{text.slice(cursor)}</React.Fragment>);
  }
  return fragments;
}

/**
 * 渲染提交面板左侧树，并在组件内部处理拖拽状态、键盘导航与 speed search。
 */
export function CommitTreePane(props: CommitTreePaneProps): React.ReactElement {
  const { t } = useTranslation(["git", "common"]);
  const {
    groups,
    inclusionState,
    statusEntryByPath,
    statusEntriesByPath,
    selectedRowKeys,
    selectedPaths,
    groupExpanded,
    treeExpanded,
    localChangesConfig,
    activeChangeListId,
    selectedDiffableEntry,
    ignoredLoading,
    busy,
    containerRef,
    onActivate,
    onSelectRow,
    onApplyTreeSelection,
    onInvokeEntryAction,
    onInvokeHoverAction,
    onResolveConflictGroup,
  onBrowseGroup,
  onIgnorePaths,
  onPerformStageOperation,
  onToggleGroupExpanded,
  onToggleTreeExpanded,
  onToggleInclusion,
    onOpenContextMenu,
    onMoveFilesToChangeList,
  } = props;
  const gt = React.useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return interpolateI18nText(String(t(key, {
      ns: "git",
      defaultValue: fallback,
      ...(values || {}),
    })), values);
  }, [t]);
  const dragPayloadRef = useRef<CommitTreeDragPayload | null>(null);
  const paneRootRef = useRef<HTMLDivElement>(null);
  const speedSearchInputRef = useRef<HTMLInputElement>(null);
  const [speedSearch, setSpeedSearch] = useState<string>("");
  const [speedSearchOpen, setSpeedSearchOpen] = useState<boolean>(false);
  const [focusedRowKey, setFocusedRowKey] = useState<string>("");
  const [hoveredRowKey, setHoveredRowKey] = useState<string>("");
  const speedSearchQuery = speedSearch.trim();
  const renderRows = useMemo(() => buildCommitPanelRenderRows(groups, groupExpanded), [groupExpanded, groups]);
  const selectedRowKeySet = useMemo(() => new Set(selectedRowKeys), [selectedRowKeys]);
  const findParentRowKey = useMemo(() => buildParentRowResolver(renderRows), [renderRows]);
  const virtual = useVirtualWindow(
    renderRows.length,
    COMMIT_TREE_ROW_HEIGHT,
    COMMIT_TREE_OVERSCAN,
    `${renderRows.length}:${Object.keys(groupExpanded).join("|")}:${Object.keys(treeExpanded).join("|")}:${busy ? 1 : 0}`,
    containerRef,
  );

  useEffect(() => {
    const preferred = selectedRowKeys[selectedRowKeys.length - 1] || "";
    if (preferred && renderRows.some((row) => row.key === preferred)) {
      setFocusedRowKey(preferred);
      return;
    }
    if (focusedRowKey && renderRows.some((row) => row.key === focusedRowKey)) return;
    setFocusedRowKey(renderRows[0]?.key || "");
  }, [focusedRowKey, renderRows, selectedRowKeys]);

  useEffect(() => {
    if (!hoveredRowKey) return;
    if (renderRows.some((row) => row.key === hoveredRowKey)) return;
    setHoveredRowKey("");
  }, [hoveredRowKey, renderRows]);

  const hoverActionOverlay = useMemo(() => {
    const preferredRowKey = hoveredRowKey || (
      selectedRowKeys.length > 0
        ? selectedRowKeys[selectedRowKeys.length - 1]
        : ""
    );
    if (!preferredRowKey) return null;
    const rowIndex = renderRows.findIndex((row) => row.key === preferredRowKey);
    if (rowIndex < 0) return null;
    const row = renderRows[rowIndex];
    if (row.kind !== "node" || !row.node.hoverAction) return null;
    const hoverAction = row.node.hoverAction;
    return {
      hoverAction,
      node: row.node,
      rowKey: preferredRowKey,
      top: rowIndex * COMMIT_TREE_ROW_HEIGHT,
    };
  }, [hoveredRowKey, renderRows, selectedRowKeys]);

  /**
   * 在拖拽结束或完成投放后清空内部缓存，避免旧路径残留到下一次拖拽。
   */
  const clearDragPayload = (): void => {
    dragPayloadRef.current = null;
  };

  /**
   * 判断焦点是否仍停留在提交树整体面板内，供滚动容器与搜索输入框共享失焦判断。
   */
  const isFocusWithinPane = (target: Node | null): boolean => {
    const root = paneRootRef.current;
    return !!root && !!target && root.contains(target);
  };

  /**
   * 统一关闭并清空 speed search；按需把焦点还给树容器，复用在 Esc、失焦与点击外部等收口逻辑。
   */
  const resetSpeedSearch = (options?: { restoreFocus?: boolean }): void => {
    setSpeedSearchOpen(false);
    setSpeedSearch("");
    if (options?.restoreFocus)
      window.requestAnimationFrame(() => {
        containerRef.current?.focus();
      });
  };

  /**
   * 执行 speed search 并把焦点定位到命中树行；主树 selection 仅在命中节点行时同步。
   */
  const applySpeedSearch = (query: string): void => {
    const nextFocusedRowKey = findCommitSpeedSearchMatch({
      rows: renderRows,
      query,
      currentRowKey: focusedRowKey || renderRows[0]?.key || "",
    });
    setFocusedRowKey(nextFocusedRowKey);
    if (nextFocusedRowKey) onApplyTreeSelection([nextFocusedRowKey]);
  };

  /**
   * 在已有 speed search 查询上跳到上一项或下一项命中，复用到 F3 / Shift+F3 快捷键。
   */
  const moveSpeedSearchMatch = (direction: "next" | "previous"): void => {
    if (!speedSearchQuery) return;
    const nextFocusedRowKey = findCommitSpeedSearchMatch({
      rows: renderRows,
      query: speedSearchQuery,
      currentRowKey: focusedRowKey || renderRows[0]?.key || "",
      direction,
    });
    setFocusedRowKey(nextFocusedRowKey);
    if (nextFocusedRowKey) onApplyTreeSelection([nextFocusedRowKey]);
  };

  /**
   * 同步可编辑搜索框的内容；沿用现有匹配与选中逻辑，只把文本输入职责交给真实 input。
   */
  const handleSpeedSearchInputChange = (nextQuery: string): void => {
    setSpeedSearch(nextQuery);
    if (!nextQuery.trim()) return;
    applySpeedSearch(nextQuery);
  };

  /**
   * 按当前焦点或选择集复制统一文本表示，顺序严格以屏幕显示顺序为准。
   */
  const copyCurrentSelectionAsync = async (): Promise<void> => {
    const copyText = buildCommitTreeCopyText({
      rows: renderRows,
      selectedRowKeys: Array.from(selectedRowKeySet),
    });
    if (!copyText) return;
    await window.host?.utils?.copyText?.(copyText);
  };

  /**
   * 解析当前键盘动作应切换的 inclusion 集；有选择时作用于选择，无选择时回落到整棵树。
   */
  const toggleInclusionFromKeyboard = (): void => {
    const activeRowKeys = selectedRowKeys.length > 0 ? selectedRowKeys : renderRows.map((row) => row.key);
    const candidateIds: string[] = [];
    const candidateRepoRoots: string[] = [];
    for (const rowKey of activeRowKeys) {
      const row = renderRows.find((one) => one.key === rowKey);
      if (!row) continue;
      if (row.kind === "group") {
        if (!isCommitGroupInclusionVisible(row.group)) continue;
        candidateIds.push(...resolveGroupItemIds(row.group));
        candidateRepoRoots.push(...resolveEntryRepoRoots(row.group.entries));
        continue;
      }
      if (!isCommitNodeInclusionVisible(row.node)) continue;
      const nodeEntries = resolveNodeEntries(row.node, statusEntriesByPath);
      candidateIds.push(...resolveNodeItemIds(row.node, statusEntriesByPath));
      candidateRepoRoots.push(...resolveEntryRepoRoots(nodeEntries));
    }
    const normalized = Array.from(new Set(candidateIds.filter(Boolean)));
    const normalizedRepoRoots = Array.from(new Set(candidateRepoRoots.filter(Boolean)));
    if (normalized.length === 0 && normalizedRepoRoots.length === 0) return;
    const checkState = getCommitInclusionCheckState(inclusionState, normalized);
    const shouldInclude = normalized.length > 0
      ? !checkState.allChecked
      : normalizedRepoRoots.some((repoRoot) => !inclusionState.includedRepoRoots.includes(repoRoot));
    onToggleInclusion(normalized, shouldInclude, normalizedRepoRoots);
  };

  useEffect(() => {
    if (!speedSearchOpen) return;

    /**
     * 点击提交面板外部时按 IDEA `focusLost -> manageSearchPopup(null)` 语义关闭并清空搜索。
     */
    const handleDocumentMouseDown = (event: MouseEvent): void => {
      const root = paneRootRef.current;
      const target = event.target as Node | null;
      if (!root || !target || root.contains(target)) return;
      resetSpeedSearch();
    };

    document.addEventListener("mousedown", handleDocumentMouseDown, true);
    return () => {
      document.removeEventListener("mousedown", handleDocumentMouseDown, true);
    };
  }, [speedSearchOpen]);

  useEffect(() => {
    if (!speedSearchOpen) return;
    const input = speedSearchInputRef.current;
    if (!input) return;
    input.focus();
    const caret = input.value.length;
    input.setSelectionRange(caret, caret);
  }, [speedSearchOpen]);

  /**
   * 统一执行 group/row 的 drop 逻辑；子孙节点命中时自动提升到根级 helper/changelist。
   */
  const canAcceptGroupDrop = (group: CommitTreeGroup): boolean => {
    const payload = dragPayloadRef.current;
    if (!payload || payload.sourceComponent !== "commit-tree") return false;
    if (localChangesConfig.stagingAreaEnabled) {
      if (group.kind === "staged") {
        return payload.entries.length > 0 && payload.entries.every(canStageDraggedEntry);
      }
      if (group.kind === "unstaged") {
        return payload.entries.length > 0 && payload.entries.every(canUnstageDraggedEntry);
      }
      return false;
    }
    const draggedChanges = resolveDragPayloadPaths(payload, "change");
    const draggedUnversionedFiles = resolveDragPayloadPaths(payload, "unversioned");
    const draggedIgnoredFiles = resolveDragPayloadPaths(payload, "ignored");
    if (group.kind === "ignored") {
      return draggedUnversionedFiles.length > 0 && draggedChanges.length === 0 && draggedIgnoredFiles.length === 0;
    }
    const groupChangeListId = resolveGroupChangeListId(group);
    if (!groupChangeListId || !localChangesConfig.changeListsEnabled || localChangesConfig.stagingAreaEnabled) return false;
    return [...draggedChanges, ...draggedUnversionedFiles, ...draggedIgnoredFiles].length > 0;
  };

  /**
   * 统一执行 group/row 的实际 drop 逻辑；子孙节点命中时自动提升到根级 helper/changelist。
   */
  const handleGroupDrop = (group: CommitTreeGroup, event: React.DragEvent): void => {
    const payload = dragPayloadRef.current;
    if (!payload || payload.sourceComponent !== "commit-tree") return;
    if (localChangesConfig.stagingAreaEnabled) {
      if (group.kind === "staged") {
        if (payload.entries.length === 0 || !payload.entries.every(canStageDraggedEntry)) return;
        event.preventDefault();
        clearDragPayload();
        void onPerformStageOperation(payload.entries, "stage");
        return;
      }
      if (group.kind === "unstaged") {
        if (payload.entries.length === 0 || !payload.entries.every(canUnstageDraggedEntry)) return;
        event.preventDefault();
        clearDragPayload();
        void onPerformStageOperation(payload.entries, "unstage");
        return;
      }
    }
    const draggedChanges = resolveDragPayloadPaths(payload, "change");
    const draggedUnversionedFiles = resolveDragPayloadPaths(payload, "unversioned");
    const draggedIgnoredFiles = resolveDragPayloadPaths(payload, "ignored");
    if (group.kind === "ignored") {
      if (draggedUnversionedFiles.length === 0 || draggedChanges.length > 0 || draggedIgnoredFiles.length > 0) return;
      event.preventDefault();
      clearDragPayload();
      onIgnorePaths(draggedUnversionedFiles, resolvePointerAnchor(event.nativeEvent));
      return;
    }
    const groupChangeListId = resolveGroupChangeListId(group);
    if (!groupChangeListId || !localChangesConfig.changeListsEnabled || localChangesConfig.stagingAreaEnabled) return;
    const incoming = [...draggedChanges, ...draggedUnversionedFiles, ...draggedIgnoredFiles];
    if (incoming.length === 0) return;
    if (group.entries.some((entry) => incoming.includes(entry.path))) return;
    event.preventDefault();
    clearDragPayload();
    void onMoveFilesToChangeList(incoming, groupChangeListId);
  };

  return (
    <div
      ref={paneRootRef}
      className="relative min-h-0 flex-1 overflow-hidden"
    >
      {speedSearchOpen ? (
        <div
          data-testid="commit-tree-speed-search"
          className="absolute left-3 top-3 z-20 flex max-w-[calc(100%-24px)] items-center gap-1 rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-2 py-1 text-xs shadow-apple-md"
        >
          <Search className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
          <input
            ref={speedSearchInputRef}
            data-testid="commit-tree-speed-search-input"
            type="text"
            value={speedSearch}
            placeholder={gt("commitTree.searchPlaceholder", "搜索")}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-[32px] flex-1 bg-transparent text-xs text-[var(--cf-text-primary)] outline-none placeholder:text-[var(--cf-text-secondary)]"
            onChange={(event) => {
              handleSpeedSearchInputChange(event.target.value);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "F3") {
                event.preventDefault();
                moveSpeedSearchMatch(event.shiftKey ? "previous" : "next");
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                resetSpeedSearch({ restoreFocus: true });
                return;
              }
              if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
                event.preventDefault();
                event.currentTarget.select();
              }
            }}
            onBlur={(event) => {
              const nextTarget = event.relatedTarget as Node | null;
              if (isFocusWithinPane(nextTarget)) return;
              resetSpeedSearch();
            }}
          />
        </div>
      ) : null}
      <div
        ref={virtual.containerRef}
        data-testid="commit-tree-scroll"
        className="min-h-0 h-full overflow-auto cf-scroll-area outline-none"
        tabIndex={0}
        onFocus={onActivate}
        onBlur={(event) => {
          const nextTarget = event.relatedTarget as Node | null;
          if (isFocusWithinPane(nextTarget)) return;
          resetSpeedSearch();
        }}
        onMouseLeave={() => {
          setHoveredRowKey("");
        }}
        onMouseDown={() => {
          containerRef.current?.focus();
          onActivate();
        }}
        onContextMenu={(event) => {
          onActivate();
          onApplyTreeSelection([]);
          onOpenContextMenu(event, "", undefined, undefined, []);
        }}
        onKeyDown={(event) => {
          const ctrl = event.ctrlKey || event.metaKey;
          if (ctrl && !event.altKey && event.key.toLowerCase() === "f") {
            event.preventDefault();
            setSpeedSearchOpen(true);
            return;
          }
          if (ctrl && !event.altKey && event.key.toLowerCase() === "c") {
            event.preventDefault();
            void copyCurrentSelectionAsync();
            return;
          }
          if (event.key === " " || event.key === "Spacebar") {
            if (renderRows.length === 0 || busy) return;
            event.preventDefault();
            toggleInclusionFromKeyboard();
            return;
          }
          if (speedSearchOpen) {
            if (event.key === "F3") {
              event.preventDefault();
              moveSpeedSearchMatch(event.shiftKey ? "previous" : "next");
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              resetSpeedSearch();
              return;
            }
            if (event.key === "Backspace") {
              event.preventDefault();
              const nextQuery = speedSearch.slice(0, -1);
              if (!nextQuery.trim()) {
                resetSpeedSearch();
                return;
              }
              setSpeedSearch(nextQuery);
              applySpeedSearch(nextQuery);
              return;
            }
            if (!ctrl && !event.altKey && event.key.length === 1) {
              event.preventDefault();
              const nextQuery = `${speedSearch}${event.key}`;
              setSpeedSearch(nextQuery);
              applySpeedSearch(nextQuery);
              return;
            }
          }
          if (!ctrl && !event.altKey && !event.shiftKey && event.key.length === 1 && /[\w\-./\\\s]/.test(event.key)) {
            event.preventDefault();
            const nextQuery = `${speedSearch}${event.key}`;
            setSpeedSearchOpen(true);
            setSpeedSearch(nextQuery);
            applySpeedSearch(nextQuery);
            return;
          }
          if (renderRows.length === 0 || busy) return;
          if (event.key === "Enter") {
            const currentRow = renderRows.find((row) => row.key === focusedRowKey);
            const targetEntry = selectedDiffableEntry || (currentRow?.kind === "node" && currentRow.node.isFile ? currentRow.node.entry : null);
            if (currentRow?.kind === "node" && currentRow.node.isFile && currentRow.node.entry) {
              event.preventDefault();
              if (currentRow.node.openHandler && canInvokeNodeOpenHandler(currentRow.key, selectedRowKeys)) {
                onInvokeHoverAction(currentRow.node, currentRow.node.openHandler.action);
                return;
              }
            }
            if (targetEntry) {
              event.preventDefault();
              onInvokeEntryAction(targetEntry, "enter");
            }
            return;
          }
          if (event.key === "F4") {
            const currentRow = renderRows.find((row) => row.key === focusedRowKey);
            const targetEntry = currentRow?.kind === "node" && currentRow.node.isFile && currentRow.node.entry
              ? currentRow.node.entry
              : selectedDiffableEntry;
            if (targetEntry) {
              event.preventDefault();
              onInvokeEntryAction(targetEntry, "f4");
            }
            return;
          }
          if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            const navigation = navigateCommitTreeRows({
              rows: renderRows,
              currentRowKey: focusedRowKey || renderRows[0]?.key || "",
              key: event.key as "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End",
              isExpanded: (rowKey) => {
                const row = renderRows.find((one) => one.key === rowKey);
                if (row?.kind !== "node") return groupExpanded[row?.group.key || ""] !== false;
                return treeExpanded[row.node.key] !== false;
              },
              findParentRowKey,
            });
            if (!navigation) return;
            event.preventDefault();
            if (navigation.toggleGroupKey) onToggleGroupExpanded(navigation.toggleGroupKey);
            if (navigation.toggleNodeKey) onToggleTreeExpanded(navigation.toggleNodeKey);
            setFocusedRowKey(navigation.focusRowKey);
            if (navigation.focusRowKey) onApplyTreeSelection([navigation.focusRowKey]);
          }
        }}
      >
        {busy ? (
          <div className="cf-git-empty-panel flex h-full items-center justify-center gap-2 px-4 text-center text-xs text-[var(--cf-text-secondary)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            {gt("commitTree.loading", "正在刷新变更树")}
          </div>
        ) : renderRows.length === 0 ? (
          <div className="cf-git-empty-panel flex h-full items-center justify-center px-4 text-center text-xs text-[var(--cf-text-secondary)]">
            {gt("commitTree.empty", "暂无可提交的变更")}
          </div>
        ) : (
          <div style={{ height: virtual.totalHeight, position: "relative" }}>
            <div style={{ height: virtual.windowState.top }} />
            {renderRows.slice(virtual.windowState.start, virtual.windowState.end).map((row) => {
              if (row.kind === "group") {
                const group = row.group;
                const groupChangeListId = resolveGroupChangeListId(group);
                const groupExpandedValue = groupExpanded[group.key] !== false;
                const groupItemIds = resolveGroupItemIds(group);
                const groupRepoRoots = resolveEntryRepoRoots(group.entries);
                const groupState = getCommitInclusionCheckState(inclusionState, groupItemIds);
                const isActiveChangeList = group.kind === "changelist" && groupChangeListId === activeChangeListId;
                const canExpandGroup = !group.manyFiles;
                const showCheckbox = isCommitGroupInclusionVisible(group);
                const selected = selectedRowKeySet.has(row.key);
                const focused = focusedRowKey === row.key;
                return (
                  <div
                    key={row.key}
                    data-testid={`commit-group-${group.key}`}
                    className={cn(
                      "cf-git-group-row flex h-6 items-center gap-2 border-b border-[var(--cf-border)] px-2 text-xs font-apple-medium text-[var(--cf-text-primary)]",
                      selected ? "cf-git-row-selected" : "",
                      focused && !selected ? "bg-[var(--cf-surface-hover)]" : "",
                    )}
                    draggable={group.entries.length > 0}
                    onDragStart={() => {
                      const dragEntries = selected
                        ? resolveSelectedDragEntries(selectedRowKeys, renderRows, statusEntriesByPath)
                        : group.entries;
                      dragPayloadRef.current = buildDragPayload(
                        dragEntries,
                      );
                    }}
                    onDragEnd={clearDragPayload}
                    onDragOver={(event) => {
                      if (!canAcceptGroupDrop(group)) return;
                      event.preventDefault();
                    }}
                    onDrop={(event) => {
                      handleGroupDrop(group, event);
                    }}
                    onClick={(event) => {
                      onActivate();
                      setFocusedRowKey(row.key);
                      onSelectRow(row.key, event);
                    }}
                    onDoubleClick={(event) => {
                      const target = event.target as HTMLElement | null;
                      if (target?.closest("button") || target?.closest("input")) return;
                      if (!canExpandGroup) return;
                      onToggleGroupExpanded(group.key);
                    }}
                    onContextMenu={(event) => {
                      const contextSelectionRowKeys = resolveContextSelectionRowKeys({ row, selectedRowKeys });
                      onActivate();
                      onApplyTreeSelection(contextSelectionRowKeys);
                      setFocusedRowKey(row.key);
                      onOpenContextMenu(event, group.key, group.kind === "changelist" ? "changelist" : "folder", groupChangeListId || undefined, contextSelectionRowKeys);
                    }}
                    onMouseEnter={() => {
                      setHoveredRowKey("");
                    }}
                  >
                    {canExpandGroup ? (
                      <button
                        data-tree-toggle="group"
                        className="inline-flex h-4 w-4 items-center justify-center rounded-apple-sm hover:bg-[var(--cf-surface-hover)]"
                        onClick={() => {
                          onToggleGroupExpanded(group.key);
                        }}
                        title={groupExpandedValue ? gt("commitTree.actions.collapseGroup", "收起分组") : gt("commitTree.actions.expandGroup", "展开分组")}
                      >
                        {groupExpandedValue ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      </button>
                    ) : (
                      <span className="inline-block h-4 w-4 shrink-0" />
                    )}
                    {showCheckbox ? (
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--cf-accent)]"
                        checked={groupState.allChecked}
                        disabled={groupItemIds.length === 0}
                        ref={(node) => {
                          if (!node) return;
                          node.indeterminate = groupState.partial;
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          onApplyTreeSelection([row.key]);
                        }}
                        onChange={(event) => {
                          onToggleInclusion(groupItemIds, event.target.checked, groupRepoRoots);
                        }}
                      />
                    ) : null}
                    <span className="truncate">
                      {speedSearchQuery ? renderSpeedSearchText(getCommitGroupTextPresentation(group), speedSearchQuery) : getCommitGroupTextPresentation(group)}
                    </span>
                    <span className="text-[10px] text-[var(--cf-text-secondary)]">({formatCommitTreeGroupSummary(group.summary, gt)})</span>
                    {group.kind === "conflict" ? (
                      <button
                        type="button"
                        className="shrink-0 text-[10px] text-[var(--cf-accent)] underline-offset-2 hover:underline"
                        onClick={(event) => {
                          event.stopPropagation();
                          onApplyTreeSelection([row.key]);
                          onResolveConflictGroup(group);
                        }}
                      >
                        {gt("commitTree.actions.resolve", "解决")}
                      </button>
                    ) : null}
                    {group.manyFiles ? (
                      <button
                        type="button"
                        className="shrink-0 text-[10px] text-[var(--cf-accent)] underline-offset-2 hover:underline"
                        onClick={(event) => {
                          event.stopPropagation();
                          onApplyTreeSelection([row.key]);
                          onBrowseGroup(group);
                        }}
                      >
                        {gt("commitTree.actions.browse", "浏览")}
                      </button>
                    ) : null}
                    {isActiveChangeList ? <span className="rounded-full bg-[var(--cf-accent-soft)] px-1.5 py-px text-[10px] text-[var(--cf-accent)]">{gt("commitTree.badges.active", "活动")}</span> : null}
                    {(group.state?.updating || (group.kind === "ignored" && ignoredLoading)) ? <Loader2 className="h-3 w-3 animate-spin text-[var(--cf-text-secondary)]" /> : null}
                    {group.state?.frozenReason ? <span className="truncate text-[10px] text-[var(--cf-warning)]" title={group.state.frozenReason}>{gt("commitTree.badges.frozen", "冻结")}</span> : null}
                    {group.state?.outdatedFileCount ? <span className="text-[10px] text-[var(--cf-text-secondary)]">{gt("commitTree.badges.outdatedFiles", "{{count}} 个过期文件", { count: group.state.outdatedFileCount })}</span> : null}
                  </div>
                );
              }

              const group = row.group;
              const node = row.node;
              const entry = node.entry;
              const nodeExpanded = treeExpanded[node.key] !== false;
              const nodeEntries = resolveNodeEntries(node, statusEntriesByPath);
              const nodeItemIds = resolveNodeItemIds(node, statusEntriesByPath);
              const nodeRepoRoots = resolveEntryRepoRoots(nodeEntries);
              const nodeCheckState = getCommitInclusionCheckState(inclusionState, nodeItemIds);
              const selected = selectedRowKeySet.has(row.key);
              const focused = focusedRowKey === row.key;
              const groupChangeListId = resolveGroupChangeListId(group);
              const showCheckbox = isCommitNodeInclusionVisible(node);

              return (
                <div
                  key={row.key}
                  data-testid={`commit-node-${node.key}`}
                  className={cn(
                    "cf-git-tree-row group flex h-6 cursor-default items-center gap-0 px-2 text-xs",
                    selected ? "cf-git-row-selected" : "",
                    focused && !selected ? "bg-[var(--cf-surface-hover)]" : "",
                  )}
                  style={{ paddingLeft: COMMIT_TREE_BASE_PADDING + row.depth * TREE_DEPTH_INDENT }}
                  onClick={(event) => {
                    if (node.selectionFlags?.nonSelectable) return;
                    onActivate();
                    setFocusedRowKey(row.key);
                    onSelectRow(row.key, event);
                  }}
                  onMouseEnter={() => {
                    setHoveredRowKey(node.hoverAction ? row.key : "");
                  }}
                  onDoubleClick={(event) => {
                    const target = event.target as HTMLElement | null;
                    if (target?.closest("input") || target?.closest("[data-tree-toggle='node']") || target?.closest("[data-hover-action='true']")) return;
                    if (!node.isFile) {
                      onToggleTreeExpanded(node.key);
                      return;
                    }
                    if (!entry) return;
                    if (node.openHandler && canInvokeNodeOpenHandler(row.key, selectedRowKeys)) {
                      onInvokeHoverAction(node, node.openHandler.action);
                      return;
                    }
                    onInvokeEntryAction(selectedDiffableEntry || entry, "doubleClick");
                  }}
                  draggable={node.filePaths.length > 0}
                  onDragStart={() => {
                    const dragEntries = selected
                      ? resolveSelectedDragEntries(selectedRowKeys, renderRows, statusEntriesByPath)
                      : resolveNodeEntries(node, statusEntriesByPath);
                    dragPayloadRef.current = buildDragPayload(dragEntries);
                  }}
                  onDragEnd={clearDragPayload}
                  onDragOver={(event) => {
                    if (!canAcceptGroupDrop(group)) return;
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    handleGroupDrop(group, event);
                  }}
                    onContextMenu={(event) => {
                      const contextSelectionRowKeys = resolveContextSelectionRowKeys({ row, selectedRowKeys });
                      onActivate();
                      setFocusedRowKey(row.key);
                      onApplyTreeSelection(contextSelectionRowKeys);
                      const nodeListIds = Array.from(new Set(
                        nodeEntries
                        .map((item) => item.changeListId || "")
                        .map((one) => String(one || "").trim())
                        .filter(Boolean),
                      ));
                      const nodeChangeListId = nodeListIds.length === 1 ? nodeListIds[0] : (groupChangeListId || "");
                      onOpenContextMenu(event, node.fullPath, node.isFile ? "file" : "folder", nodeChangeListId || undefined, contextSelectionRowKeys);
                    }}
                  title={getCommitNodeTextPresentation(node)}
                >
                  {showCheckbox ? (
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--cf-accent)]"
                      checked={nodeCheckState.allChecked}
                      disabled={nodeItemIds.length === 0}
                      ref={(dom) => {
                        if (!dom) return;
                        dom.indeterminate = nodeCheckState.partial;
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        onApplyTreeSelection([row.key]);
                      }}
                      onChange={(event) => {
                        onToggleInclusion(nodeItemIds, event.target.checked, nodeRepoRoots);
                      }}
                    />
                  ) : null}
                  {node.isFile ? (
                    <>
                      <span className="h-3.5 w-3.5 shrink-0" />
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[var(--cf-accent)] opacity-90" />
                    </>
                  ) : (
                    <>
                      <button
                        data-tree-toggle="node"
                        className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-apple-sm hover:bg-[var(--cf-surface-hover)]"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onToggleTreeExpanded(node.key);
                        }}
                        title={nodeExpanded ? gt("commitTree.tree.collapse", "收起") : gt("commitTree.tree.expand", "展开")}
                      >
                        {nodeExpanded ? <ChevronDown className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" /> : <ChevronRight className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />}
                      </button>
                      <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--cf-text-secondary)]" />
                    </>
                  )}
                  <span className="min-w-0 flex-1 truncate" title={getCommitNodeTextPresentation(node)}>
                    {speedSearchQuery ? renderSpeedSearchText(getCommitNodeTextPresentation(node), speedSearchQuery) : getCommitNodeTextPresentation(node)}
                  </span>
                  {!node.isFile ? (
                    <span className="ml-0.5 shrink-0 text-[10px] text-[var(--cf-text-secondary)]">
                      {gt("commitTree.tree.nodeFileCount", "{{count}} 个文件", { count: node.fileCount || node.count })}
                    </span>
                  ) : null}
                </div>
              );
            })}
            {hoverActionOverlay ? (
              <div
                data-hover-overlay="true"
                className="pointer-events-none absolute right-2 z-10 flex items-center"
                style={{
                  top: hoverActionOverlay.top,
                  height: COMMIT_TREE_ROW_HEIGHT,
                }}
              >
                <button
                  type="button"
                  data-testid={`commit-hover-action-${hoverActionOverlay.node.key}`}
                  data-hover-action="true"
                  className="pointer-events-auto rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-1.5 py-0.5 text-[10px] text-[var(--cf-accent)] shadow-apple-sm hover:bg-[var(--cf-surface-hover)]"
                  title={hoverActionOverlay.hoverAction.tooltip}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onInvokeHoverAction(hoverActionOverlay.node, hoverActionOverlay.hoverAction.action);
                  }}
                >
                  {hoverActionOverlay.hoverAction.iconLabel}
                </button>
              </div>
            ) : null}
            <div style={{ height: virtual.windowState.bottom }} />
          </div>
        )}
      </div>
    </div>
  );
}
