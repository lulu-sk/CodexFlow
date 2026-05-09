// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, FileCode2, Folder, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { resolveGitTextWith } from "../git-i18n";
import type { GitStatusEntry, GitViewOptions } from "../types";
import { useVirtualWindow } from "../use-virtual-window";
import { resolveSpecialFilesActionGroups } from "./action-groups";
import { SPECIAL_FILES_ROW_HEIGHT } from "./config";
import { normalizeCommitGroupingKeys } from "./config";
import { buildSpecialFilesDataSnapshot } from "./data-context";
import { buildCommitTree } from "./changes-tree-view-model";
import { buildCommitTreeCopyText, findCommitSpeedSearchMatch } from "./tree-interactions";
import type { CommitPanelRenderRow, CommitSpecialFilesDialogKind } from "./types";

const SPECIAL_FILES_OVERSCAN = 8;

type BrowseDialogState = {
  expanded: Record<string, boolean>;
  selectedNodeKeys: string[];
  focusedNodeKey: string;
  speedSearch: string;
  speedSearchOpen: boolean;
  groupingKeys: Array<"directory" | "module" | "repository">;
};

type SpecialFilesActionMenuState = {
  x: number;
  y: number;
};

type SpecialFilesDialogProps = {
  open: boolean;
  cacheKey: string;
  kind: CommitSpecialFilesDialogKind;
  title: string;
  description: string;
  entries: GitStatusEntry[];
  viewOptions: GitViewOptions;
  initialGroupingKeys: ReadonlyArray<"directory" | "module" | "repository">;
  availableGroupingKeys: ReadonlyArray<"directory" | "module" | "repository">;
  onOpenChange: (open: boolean) => void;
  onInvokeEntryAction: (entry: GitStatusEntry, intent: "doubleClick" | "f4" | "enter" | "singleClick") => Promise<void> | void;
  onStagePaths: (paths: string[]) => Promise<void>;
  onDeletePaths: (paths: string[]) => Promise<void>;
  onIgnoreEntries: (entries: GitStatusEntry[], anchor?: { x: number; y: number }) => void;
};

/**
 * 创建 Browse 对话框默认状态；首次打开时默认清空查询并保留独立缓存键。
 */
function createBrowseDialogState(): BrowseDialogState {
  return {
    expanded: {},
    selectedNodeKeys: [],
    focusedNodeKey: "",
    speedSearch: "",
    speedSearchOpen: false,
    groupingKeys: ["directory"],
  };
}

/**
 * 提取当前选中节点集合对应的真实文件路径；目录节点会递归展开到其子文件。
 */
function resolveBrowseSelectedPaths(
  selectedNodeKeys: string[],
  rows: Array<{ node: ReturnType<typeof buildCommitTree>[number]; depth: number }>,
): string[] {
  const selectedKeySet = new Set(selectedNodeKeys);
  const pathSet = new Set<string>();
  for (const row of rows) {
    if (!selectedKeySet.has(row.node.key)) continue;
    for (const one of row.node.filePaths) {
      const cleanPath = String(one || "").trim();
      if (cleanPath) pathSet.add(cleanPath);
    }
  }
  return Array.from(pathSet);
}

/**
 * 仅提取 exact selection 中直接命中的文件路径，不递归展开目录节点。
 */
function resolveBrowseExactlySelectedPaths(
  selectedNodeKeys: string[],
  rows: Array<{ node: ReturnType<typeof buildCommitTree>[number]; depth: number }>,
): string[] {
  const selectedKeySet = new Set(selectedNodeKeys);
  const pathSet = new Set<string>();
  for (const row of rows) {
    if (!selectedKeySet.has(row.node.key) || !row.node.isFile) continue;
    const cleanPath = String(row.node.filePaths[0] || "").trim();
    if (cleanPath) pathSet.add(cleanPath);
  }
  return Array.from(pathSet);
}

/**
 * 解析 Browse 树当前焦点节点；无显式焦点时回落到首个可见节点，仅用于键盘定位而不伪造真实选区。
 */
function resolveBrowseFocusedNodeKey(
  focusedNodeKey: string,
  rows: Array<{ node: ReturnType<typeof buildCommitTree>[number]; depth: number }>,
): string {
  if (focusedNodeKey && rows.some((row) => row.node.key === focusedNodeKey)) return focusedNodeKey;
  return rows[0]?.node.key || "";
}

/**
 * 解析 Browse 视图当前 lead selection；多选时返回最后一个真实选中节点，无选区时返回空字符串。
 */
function resolveBrowseLeadNodeKey(selectedNodeKeys: string[], rows: Array<{ node: ReturnType<typeof buildCommitTree>[number]; depth: number }>): string {
  for (let index = selectedNodeKeys.length - 1; index >= 0; index -= 1) {
    const nodeKey = selectedNodeKeys[index];
    if (rows.some((row) => row.node.key === nodeKey)) return nodeKey;
  }
  return "";
}

/**
 * 按 IDEA Browse 首开语义生成默认展开态；仅当根下恰有一个目录节点时自动展开该单根节点。
 */
function buildBrowseDefaultExpandedState(nodes: ReturnType<typeof buildCommitTree>): Record<string, boolean> {
  const firstNode = nodes[0];
  if (nodes.length === 1 && firstNode && !firstNode.isFile)
    return { [firstNode.key]: true };
  return {};
}

/**
 * 解析 Browse 节点当前是否处于展开态；未显式声明时回落到默认展开策略而非“全部展开”。
 */
function isBrowseNodeExpanded(
  nodeKey: string,
  expanded: Record<string, boolean>,
  defaultExpanded: Record<string, boolean>,
): boolean {
  if (Object.prototype.hasOwnProperty.call(expanded, nodeKey)) return expanded[nodeKey] !== false;
  return defaultExpanded[nodeKey] === true;
}

/**
 * 按 Browse 的默认折叠规则扁平化树结构，避免复用主树“未声明即展开”的策略。
 */
function flattenBrowseTree(
  nodes: ReturnType<typeof buildCommitTree>,
  expanded: Record<string, boolean>,
  defaultExpanded: Record<string, boolean>,
  depth: number = 0,
): Array<{ node: ReturnType<typeof buildCommitTree>[number]; depth: number }> {
  const out: Array<{ node: ReturnType<typeof buildCommitTree>[number]; depth: number }> = [];
  for (const node of nodes) {
    out.push({ node, depth });
    if (!node.isFile && isBrowseNodeExpanded(node.key, expanded, defaultExpanded)) {
      out.push(...flattenBrowseTree(node.children, expanded, defaultExpanded, depth + 1));
    }
  }
  return out;
}

/**
 * 将 Browse 树行转换为 copy/speed search 复用的统一行模型。
 */
function buildBrowseRenderRows(
  rows: Array<{ node: ReturnType<typeof buildCommitTree>[number]; depth: number }>,
  cacheKey: string,
): CommitPanelRenderRow[] {
  return rows.map((row) => ({
    key: `node:${row.node.key}`,
    kind: "node",
    group: {
      key: `browse:${cacheKey}`,
      label: cacheKey,
      entries: [],
      kind: "unversioned",
      treeNodes: [],
      treeRows: [],
    } as any,
    node: row.node as any,
    depth: row.depth,
    textPresentation: row.node.name,
  }));
}

/**
 * 提交面板 special node 的 Browse 对话框，使用树结构和 popup 动作收敛到 IDEA `SpecificFilesViewDialog`。
 */
export function SpecialFilesDialog(props: SpecialFilesDialogProps): React.ReactElement {
  const { t } = useTranslation(["git", "common"]);
  const {
    open,
    cacheKey,
    kind,
    title,
    description,
    entries,
    viewOptions,
    initialGroupingKeys,
    availableGroupingKeys,
    onOpenChange,
    onInvokeEntryAction,
    onStagePaths,
    onDeletePaths,
    onIgnoreEntries,
  } = props;
  const gt = React.useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveGitTextWith(t, key, fallback, values);
  }, [t]);
  const [stateByKey, setStateByKey] = useState<Record<string, BrowseDialogState>>({});
  const [actionMenuState, setActionMenuState] = useState<SpecialFilesActionMenuState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const speedSearchInputRef = useRef<HTMLInputElement>(null);
  const currentState = stateByKey[cacheKey] || createBrowseDialogState();
  const entryByPath = useMemo(() => new Map(entries.map((entry) => [String(entry.path || "").replace(/\\/g, "/"), entry] as const)), [entries]);
  const effectiveGroupingKeys = useMemo(() => (
    normalizeCommitGroupingKeys(currentState.groupingKeys, false).filter((key) => availableGroupingKeys.includes(key))
  ), [availableGroupingKeys, currentState.groupingKeys]);
  const treeNodes = useMemo(() => buildCommitTree(entries, `browse:${cacheKey}`, effectiveGroupingKeys), [cacheKey, effectiveGroupingKeys, entries]);
  const defaultExpanded = useMemo(() => buildBrowseDefaultExpandedState(treeNodes), [treeNodes]);
  const treeRows = useMemo(() => flattenBrowseTree(treeNodes, currentState.expanded, defaultExpanded), [currentState.expanded, defaultExpanded, treeNodes]);
  const renderRows = useMemo(() => buildBrowseRenderRows(treeRows, cacheKey), [cacheKey, treeRows]);
  const selectedNodeKeySet = useMemo(() => new Set(currentState.selectedNodeKeys), [currentState.selectedNodeKeys]);
  const selectedPaths = useMemo(() => resolveBrowseSelectedPaths(currentState.selectedNodeKeys, treeRows), [currentState.selectedNodeKeys, treeRows]);
  const exactlySelectedPaths = useMemo(() => resolveBrowseExactlySelectedPaths(currentState.selectedNodeKeys, treeRows), [currentState.selectedNodeKeys, treeRows]);
  const leadSelectedNodeKey = useMemo(() => resolveBrowseLeadNodeKey(currentState.selectedNodeKeys, treeRows), [currentState.selectedNodeKeys, treeRows]);
  const focusedNodeKey = useMemo(() => resolveBrowseFocusedNodeKey(currentState.focusedNodeKey, treeRows), [currentState.focusedNodeKey, treeRows]);
  const selectedEntries = useMemo(() => (
    selectedPaths
      .map((pathText) => entryByPath.get(String(pathText || "").replace(/\\/g, "/")))
      .filter((entry): entry is GitStatusEntry => !!entry)
  ), [entryByPath, selectedPaths]);
  const actionGroups = useMemo(() => resolveSpecialFilesActionGroups(kind), [kind]);
  const dataSnapshot = useMemo(() => buildSpecialFilesDataSnapshot({
    kind,
    selectedEntries,
    selectedPaths,
    exactlySelectedPaths,
    localChangesConfig: { stagingAreaEnabled: false, changeListsEnabled: false },
  }), [exactlySelectedPaths, kind, selectedEntries, selectedPaths]);
  const virtual = useVirtualWindow(
    treeRows.length,
    SPECIAL_FILES_ROW_HEIGHT,
    SPECIAL_FILES_OVERSCAN,
    `${open ? 1 : 0}:${cacheKey}:${treeRows.length}:${Object.keys(currentState.expanded).join("|")}`,
    containerRef,
  );

  /**
   * 更新当前缓存键对应的对话框内部状态，避免不同 Browse 视图互相污染。
   */
  const patchBrowseState = (patch: Partial<BrowseDialogState>): void => {
    setStateByKey((prev) => ({
      ...prev,
      [cacheKey]: {
        ...(prev[cacheKey] || createBrowseDialogState()),
        ...patch,
      },
    }));
  };

  /**
   * 判断焦点是否仍停留在 Browse 树整体区域内，供滚动容器与搜索输入框共享失焦豁免。
   */
  const isFocusWithinBrowseTree = (target: Node | null): boolean => {
    const root = containerRef.current;
    return !!root && !!target && root.contains(target);
  };

  /**
   * 统一关闭并清空 Browse speed search；按需把焦点还给树容器，复用到 Esc、失焦与点击外部。
   */
  const resetSpeedSearch = (options?: { restoreFocus?: boolean }): void => {
    patchBrowseState({ speedSearchOpen: false, speedSearch: "" });
    if (options?.restoreFocus)
      window.requestAnimationFrame(() => {
        containerRef.current?.focus();
      });
  };

  /**
   * 按函数式方式更新当前 Browse 状态，确保连续点击/快捷键多选不会读取到过期闭包。
   */
  const updateBrowseState = (updater: (state: BrowseDialogState) => BrowseDialogState): void => {
    setStateByKey((prev) => {
      const current = prev[cacheKey] || createBrowseDialogState();
      return {
        ...prev,
        [cacheKey]: updater(current),
      };
    });
  };

  /**
   * 按 Browse 树真实选区规则应用单选 / Ctrl 多选 / Shift 连续选择，避免 many-files 对话框继续退化成强单选。
   */
  const applyBrowseSelection = (nodeKey: string, event?: Pick<React.MouseEvent, "shiftKey" | "ctrlKey" | "metaKey">): void => {
    if (!nodeKey) return;
    updateBrowseState((state) => {
      if (event?.shiftKey && state.selectedNodeKeys.length > 0) {
        const anchorKey = state.selectedNodeKeys[state.selectedNodeKeys.length - 1];
        const from = treeRows.findIndex((row) => row.node.key === anchorKey);
        const to = treeRows.findIndex((row) => row.node.key === nodeKey);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          return {
            ...state,
            selectedNodeKeys: treeRows.slice(start, end + 1).map((row) => row.node.key),
            focusedNodeKey: nodeKey,
          };
        }
      }
      if (event?.ctrlKey || event?.metaKey) {
        return {
          ...state,
          selectedNodeKeys: state.selectedNodeKeys.includes(nodeKey)
            ? state.selectedNodeKeys.filter((one) => one !== nodeKey)
            : [...state.selectedNodeKeys, nodeKey],
          focusedNodeKey: nodeKey,
        };
      }
      return {
        ...state,
        selectedNodeKeys: [nodeKey],
        focusedNodeKey: nodeKey,
      };
    });
  };

  useEffect(() => {
    const normalizedInitialKeys = normalizeCommitGroupingKeys(initialGroupingKeys, true).filter((key) => availableGroupingKeys.includes(key));
    if (normalizedInitialKeys.join("|") === currentState.groupingKeys.join("|")) return;
    patchBrowseState({ groupingKeys: normalizedInitialKeys });
  }, [availableGroupingKeys, cacheKey, currentState.groupingKeys, initialGroupingKeys]);

  /**
   * 切换某个目录节点的展开状态；未命中过往状态时回落到默认展开策略而不是“全部展开”。
   */
  const toggleExpanded = (nodeKey: string): void => {
    const nextExpanded = !isBrowseNodeExpanded(nodeKey, currentState.expanded, defaultExpanded);
    patchBrowseState({
      expanded: {
        ...currentState.expanded,
        [nodeKey]: nextExpanded,
      },
    });
  };

  /**
   * 重建后仅保留仍存在且仍有子项的展开键，并同步收敛失效焦点与失效选区。
   */
  useEffect(() => {
    const validDirectoryKeys = new Set<string>();
    /**
     * 遍历当前 Browse 树的全部目录节点，供 KEEP_NON_EMPTY 展开态过滤复用。
     */
    const walk = (nodes: ReturnType<typeof buildCommitTree>): void => {
      for (const node of nodes) {
        if (node.isFile || node.children.length === 0) continue;
        validDirectoryKeys.add(node.key);
        walk(node.children);
      }
    };
    walk(treeNodes);
    const nextExpanded = Object.fromEntries(
      Object.entries(currentState.expanded).filter(([key]) => validDirectoryKeys.has(key)),
    );
    const nextSelectedNodeKeys = currentState.selectedNodeKeys.filter((nodeKey) => treeRows.some((row) => row.node.key === nodeKey));
    const nextFocusedNodeKey = resolveBrowseFocusedNodeKey(currentState.focusedNodeKey, treeRows);
    if (
      JSON.stringify(nextExpanded) === JSON.stringify(currentState.expanded)
      && JSON.stringify(nextSelectedNodeKeys) === JSON.stringify(currentState.selectedNodeKeys)
      && nextFocusedNodeKey === currentState.focusedNodeKey
    ) return;
    patchBrowseState({
      expanded: nextExpanded,
      selectedNodeKeys: nextSelectedNodeKeys,
      focusedNodeKey: nextFocusedNodeKey,
    });
  }, [cacheKey, currentState.expanded, currentState.focusedNodeKey, currentState.selectedNodeKeys, treeNodes, treeRows]);

  useEffect(() => {
    if (!open) {
      setActionMenuState(null);
      return;
    }
    const timer = window.setTimeout(() => {
      if (speedSearchInputRef.current) return;
      containerRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!currentState.speedSearchOpen) return;

    /**
     * 点击 Browse 树外部时按统一 speed search 规则关闭并清空当前搜索。
     */
    const handleDocumentMouseDown = (event: MouseEvent): void => {
      const root = containerRef.current;
      const target = event.target as Node | null;
      if (!root || !target || root.contains(target)) return;
      resetSpeedSearch();
    };

    document.addEventListener("mousedown", handleDocumentMouseDown, true);
    return () => {
      document.removeEventListener("mousedown", handleDocumentMouseDown, true);
    };
  }, [currentState.speedSearchOpen, cacheKey]);

  useEffect(() => {
    if (!currentState.speedSearchOpen) return;
    const input = speedSearchInputRef.current;
    if (!input) return;
    input.focus();
    const caret = input.value.length;
    input.setSelectionRange(caret, caret);
  }, [currentState.speedSearchOpen, cacheKey]);

  useEffect(() => {
    if (!actionMenuState) return;
    const close = (): void => {
      setActionMenuState(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [actionMenuState]);

  /**
   * 按当前选中结果执行 Browse 动作集；open 成功后关闭对话框，对齐 IDEA Browse 行为。
   */
  const runCurrentActionAsync = async (action: "open" | "stage" | "ignore" | "delete"): Promise<void> => {
    const selectedNode = treeRows.find((row) => row.node.key === leadSelectedNodeKey)?.node || null;
    const selectedEntry = selectedNode ? (entryByPath.get(selectedNode.filePaths[0] || "") || null) : null;
    const effectiveSelectedPaths = selectedPaths;
    if (action === "open" && !selectedNode) return;
    if (action === "open" && selectedNode?.isFile && selectedEntry) {
      await onInvokeEntryAction(selectedEntry, "enter");
      onOpenChange(false);
      return;
    }
    if (action === "open" && selectedNode && !selectedNode.isFile) {
      toggleExpanded(selectedNode.key);
      return;
    }
    if (effectiveSelectedPaths.length === 0) return;
    if (action === "stage") {
      await onStagePaths(effectiveSelectedPaths);
      return;
    }
    if (action === "delete") {
      await onDeletePaths(effectiveSelectedPaths);
      return;
    }
    onIgnoreEntries(selectedEntries, actionMenuState ? { x: actionMenuState.x, y: actionMenuState.y } : undefined);
  };

  /**
   * 在 Browse 树内应用 speed search，主树和 Browse 都复用同样的 popup 语义。
   */
  const applySpeedSearch = (query: string): void => {
    const nextKey = findCommitSpeedSearchMatch({
      rows: renderRows,
      query,
      currentRowKey: focusedNodeKey ? `node:${focusedNodeKey}` : renderRows[0]?.key || "",
    });
    patchBrowseState({
      selectedNodeKeys: nextKey ? [String(nextKey).replace(/^node:/, "")] : [],
      focusedNodeKey: nextKey ? String(nextKey).replace(/^node:/, "") : "",
    });
  };

  /**
   * 在当前 Browse 查询结果中跳到上一项或下一项命中，供 F3 / Shift+F3 与输入框复用。
   */
  const moveSpeedSearchMatch = (direction: "next" | "previous"): void => {
    const query = currentState.speedSearch.trim();
    if (!query) return;
    const nextKey = findCommitSpeedSearchMatch({
      rows: renderRows,
      query,
      currentRowKey: focusedNodeKey ? `node:${focusedNodeKey}` : renderRows[0]?.key || "",
      direction,
    });
    patchBrowseState({
      selectedNodeKeys: nextKey ? [String(nextKey).replace(/^node:/, "")] : [],
      focusedNodeKey: nextKey ? String(nextKey).replace(/^node:/, "") : "",
    });
  };

  /**
   * 同步可编辑搜索框的内容；仍沿用现有 Browse 匹配与选区联动逻辑。
   */
  const handleSpeedSearchInputChange = (nextQuery: string): void => {
    patchBrowseState({ speedSearch: nextQuery });
    if (!nextQuery.trim()) return;
    applySpeedSearch(nextQuery);
  };

  /**
   * 在点击 Browse 树时优先让滚动容器重新拿到焦点，保证后续字符键与 Ctrl+F 仍然可用。
   */
  const handleTreeMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as Node | null;
    if (speedSearchInputRef.current && target && speedSearchInputRef.current.contains(target)) return;
    containerRef.current?.focus();
  };

  /**
   * 按当前可见顺序复制 Browse 树文本表示，与主树 copy provider 语义保持一致。
   */
  const copyBrowseSelectionAsync = async (): Promise<void> => {
    const copyText = buildCommitTreeCopyText({
      rows: renderRows,
      selectedRowKeys: currentState.selectedNodeKeys.map((nodeKey) => `node:${nodeKey}`),
    });
    if (!copyText) return;
    await window.host?.utils?.copyText?.(copyText);
  };
  const canUseGroupingToolbar = effectiveGroupingKeys.length > 0;
  const canExpandAll = canUseGroupingToolbar && treeRows.some((row) => !row.node.isFile && !isBrowseNodeExpanded(row.node.key, currentState.expanded, defaultExpanded));
  const canCollapseAll = canUseGroupingToolbar && treeRows.some((row) => !row.node.isFile && isBrowseNodeExpanded(row.node.key, currentState.expanded, defaultExpanded));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="mt-2 flex min-h-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            {availableGroupingKeys.includes("repository") ? (
              <Button
                size="xs"
                variant={effectiveGroupingKeys.includes("repository") ? "secondary" : "ghost"}
                onClick={() => patchBrowseState({
                  groupingKeys: effectiveGroupingKeys.includes("repository")
                    ? effectiveGroupingKeys.filter((key) => key !== "repository")
                    : [...effectiveGroupingKeys, "repository"],
                })}
              >
                {gt("workbench.changes.viewMenu.groupRepository", "仓库")}
              </Button>
            ) : null}
            {availableGroupingKeys.includes("module") ? (
              <Button
                size="xs"
                variant={effectiveGroupingKeys.includes("module") ? "secondary" : "ghost"}
                onClick={() => patchBrowseState({
                  groupingKeys: effectiveGroupingKeys.includes("module")
                    ? effectiveGroupingKeys.filter((key) => key !== "module")
                    : [...effectiveGroupingKeys, "module"],
                })}
              >
                {gt("workbench.changes.viewMenu.groupModule", "模块")}
              </Button>
            ) : null}
            {availableGroupingKeys.includes("directory") ? (
              <Button
                size="xs"
                variant={effectiveGroupingKeys.includes("directory") ? "secondary" : "ghost"}
                onClick={() => patchBrowseState({
                  groupingKeys: effectiveGroupingKeys.includes("directory")
                    ? effectiveGroupingKeys.filter((key) => key !== "directory")
                    : [...effectiveGroupingKeys, "directory"],
                })}
              >
                {gt("workbench.changes.viewMenu.groupDirectory", "目录")}
              </Button>
            ) : null}
            {canUseGroupingToolbar ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={!canExpandAll}
                onClick={() => patchBrowseState({
                  expanded: Object.fromEntries(treeRows.filter((row) => !row.node.isFile).map((row) => [row.node.key, true])),
                })}
              >
                {gt("workbench.changes.toolbar.expandAll", "展开全部")}
              </Button>
            ) : null}
            {canUseGroupingToolbar ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={!canCollapseAll}
                onClick={() => patchBrowseState({
                  expanded: Object.fromEntries(treeRows.filter((row) => !row.node.isFile).map((row) => [row.node.key, false])),
                })}
              >
                {gt("workbench.changes.toolbar.collapseAll", "收起全部")}
              </Button>
            ) : null}
            {kind === "ignored" ? (
              <Button
                size="xs"
                variant="secondary"
                data-action-group={actionGroups.toolbarActionGroupId}
                disabled={!dataSnapshot.canDelete || selectedPaths.length === 0}
                onClick={() => void runCurrentActionAsync("delete")}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                {gt("specialFilesDialog.actions.delete", "删除")}
              </Button>
            ) : kind === "unversioned" ? (
              <>
                <Button
                  size="xs"
                  variant="secondary"
                  data-action-group={actionGroups.toolbarActionGroupId}
                  disabled={!dataSnapshot.canAddToVcs || selectedPaths.length === 0}
                  onClick={() => void runCurrentActionAsync("stage")}
                >
                  {gt("workbench.changes.context.addToVcs", "添加到 VCS")}
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  data-action-group={actionGroups.toolbarActionGroupId}
                  disabled={!dataSnapshot.canAddToVcs || selectedPaths.length === 0}
                  onClick={() => void runCurrentActionAsync("ignore")}
                >
                  {gt("workbench.changes.context.ignore", "忽略")}
                </Button>
              </>
            ) : null}
            {kind === "conflict" ? (
              <Button
                size="xs"
                variant="secondary"
                data-action-group={actionGroups.toolbarActionGroupId}
                disabled={selectedPaths.length === 0}
                onClick={() => void runCurrentActionAsync("open")}
              >
                {gt("specialFilesDialog.actions.resolveSelectedConflicts", "解决选中冲突")}
              </Button>
            ) : null}
            <div className="ml-auto text-[11px] text-[var(--cf-text-secondary)]">
              {gt("specialFilesDialog.summary.count", "共 {{count}} 项", { count: entries.length })}
              {kind === "conflict"
                ? gt("specialFilesDialog.summary.conflictHint", "；回车/双击打开 Merge")
                : !viewOptions.diffPreviewOnDoubleClickOrEnter
                  ? gt("specialFilesDialog.summary.openSourceHint", "；回车/双击将打开源文件")
                  : gt("specialFilesDialog.summary.openDiffHint", "；回车/双击优先打开 Diff")}
            </div>
          </div>
          <div
            ref={containerRef}
            data-testid="special-files-tree"
            className="relative h-[420px] overflow-auto rounded-apple-sm border border-[var(--cf-border)] cf-scroll-area outline-none"
            tabIndex={0}
            onBlur={(event) => {
              const nextTarget = event.relatedTarget as Node | null;
              if (isFocusWithinBrowseTree(nextTarget)) return;
              resetSpeedSearch();
            }}
            onMouseDown={handleTreeMouseDown}
            onKeyDown={(event) => {
              const ctrl = event.ctrlKey || event.metaKey;
              if (ctrl && !event.altKey && event.key.toLowerCase() === "f") {
                event.preventDefault();
                patchBrowseState({ speedSearchOpen: true });
                return;
              }
              if (ctrl && !event.altKey && event.key.toLowerCase() === "c") {
                event.preventDefault();
                void copyBrowseSelectionAsync();
                return;
              }
              if (currentState.speedSearchOpen) {
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
                  const nextQuery = currentState.speedSearch.slice(0, -1);
                  patchBrowseState({ speedSearch: nextQuery });
                  applySpeedSearch(nextQuery);
                  return;
                }
                if (!ctrl && !event.altKey && event.key.length === 1) {
                  event.preventDefault();
                  const nextQuery = `${currentState.speedSearch}${event.key}`;
                  patchBrowseState({ speedSearch: nextQuery });
                  applySpeedSearch(nextQuery);
                  return;
                }
              }
              if (!ctrl && !event.altKey && !event.shiftKey && event.key.length === 1 && /[\w\-./\\\s]/.test(event.key)) {
                event.preventDefault();
                const nextQuery = `${currentState.speedSearch}${event.key}`;
                patchBrowseState({ speedSearchOpen: true, speedSearch: nextQuery });
                applySpeedSearch(nextQuery);
                return;
              }
              if (treeRows.length === 0) return;
              const currentIndex = Math.max(0, treeRows.findIndex((row) => row.node.key === focusedNodeKey));
              if (event.key === "ArrowDown") {
                event.preventDefault();
                const nextNodeKey = treeRows[Math.min(treeRows.length - 1, currentIndex + 1)]?.node.key || focusedNodeKey;
                patchBrowseState({ selectedNodeKeys: nextNodeKey ? [nextNodeKey] : [], focusedNodeKey: nextNodeKey });
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                const nextNodeKey = treeRows[Math.max(0, currentIndex - 1)]?.node.key || focusedNodeKey;
                patchBrowseState({ selectedNodeKeys: nextNodeKey ? [nextNodeKey] : [], focusedNodeKey: nextNodeKey });
                return;
              }
              if (event.key === "Home") {
                event.preventDefault();
                const nextNodeKey = treeRows[0]?.node.key || focusedNodeKey;
                patchBrowseState({ selectedNodeKeys: nextNodeKey ? [nextNodeKey] : [], focusedNodeKey: nextNodeKey });
                return;
              }
              if (event.key === "End") {
                event.preventDefault();
                const nextNodeKey = treeRows[treeRows.length - 1]?.node.key || focusedNodeKey;
                patchBrowseState({ selectedNodeKeys: nextNodeKey ? [nextNodeKey] : [], focusedNodeKey: nextNodeKey });
                return;
              }
              if (event.key === "ArrowRight") {
                const currentNode = treeRows[currentIndex]?.node;
                if (!currentNode || currentNode.isFile) return;
                event.preventDefault();
                if (!isBrowseNodeExpanded(currentNode.key, currentState.expanded, defaultExpanded)) toggleExpanded(currentNode.key);
                return;
              }
              if (event.key === "ArrowLeft") {
                const currentNode = treeRows[currentIndex]?.node;
                if (!currentNode || currentNode.isFile) return;
                event.preventDefault();
                if (isBrowseNodeExpanded(currentNode.key, currentState.expanded, defaultExpanded)) toggleExpanded(currentNode.key);
                return;
              }
              if (event.key === "F4") {
                const currentEntry = entryByPath.get(resolveBrowseExactlySelectedPaths([leadSelectedNodeKey], treeRows)[0] || "");
                if (!currentEntry) return;
                event.preventDefault();
                void onInvokeEntryAction(currentEntry, "f4");
                onOpenChange(false);
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                void runCurrentActionAsync("open");
              }
            }}
          >
            {currentState.speedSearchOpen ? (
              <div
                data-testid="special-files-speed-search"
                className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-2 py-1 text-xs shadow-apple-md"
              >
                <Search className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                <input
                  ref={speedSearchInputRef}
                  data-testid="special-files-speed-search-input"
                  type="text"
                  value={currentState.speedSearch}
                  placeholder={gt("specialFilesDialog.searchPlaceholder", "搜索")}
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
                    if (isFocusWithinBrowseTree(nextTarget)) return;
                    resetSpeedSearch();
                  }}
                />
              </div>
            ) : null}
            {treeRows.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-[var(--cf-text-secondary)]">
                {gt("specialFilesDialog.empty", "无匹配项")}
              </div>
            ) : (
              <div style={{ height: virtual.totalHeight }}>
                <div style={{ height: virtual.windowState.top }} />
                {treeRows.slice(virtual.windowState.start, virtual.windowState.end).map((row) => {
                  const selected = selectedNodeKeySet.has(row.node.key);
                  const entry = entryByPath.get(row.node.filePaths[0] || "");
                  const expanded = isBrowseNodeExpanded(row.node.key, currentState.expanded, defaultExpanded);
                  return (
                    <div
                      key={row.node.key}
                      data-testid={`special-files-row-${row.node.key}`}
                      className={cn(
                        "flex items-center gap-1 border-b border-[var(--cf-border)] px-2 text-xs",
                        selected ? "cf-git-row-selected" : "hover:bg-[var(--cf-surface-hover)]",
                        focusedNodeKey === row.node.key && !selected ? "bg-[var(--cf-surface-hover)]" : "",
                      )}
                      style={{ height: SPECIAL_FILES_ROW_HEIGHT, paddingLeft: 12 + row.depth * 18 }}
                      onClick={(event) => applyBrowseSelection(row.node.key, event)}
                      onDoubleClick={async (event) => {
                        const target = event.target as HTMLElement | null;
                        if (target?.closest("button")) return;
                        if (!row.node.isFile) {
                          toggleExpanded(row.node.key);
                          return;
                        }
                        if (!entry) return;
                        await onInvokeEntryAction(entry, "doubleClick");
                        onOpenChange(false);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        if (!selectedNodeKeySet.has(row.node.key)) applyBrowseSelection(row.node.key);
                        setActionMenuState({ x: event.clientX, y: event.clientY });
                      }}
                      title={row.node.fullPath}
                    >
                      {row.node.isFile ? (
                        <>
                          <span className="h-3.5 w-3.5 shrink-0" />
                          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[var(--cf-accent)]" />
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            data-testid={`special-files-toggle-${row.node.key}`}
                            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-apple-sm hover:bg-[var(--cf-surface-hover)]"
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleExpanded(row.node.key);
                            }}
                          >
                            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </button>
                          <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--cf-text-secondary)]" />
                        </>
                      )}
                      <span className="min-w-0 flex-1 truncate">{row.node.name}</span>
                      {!row.node.isFile ? <span className="text-[10px] text-[var(--cf-text-secondary)]">{gt("details.browser.tree.nodeFileCount", "{{count}} 个文件", { count: row.node.count })}</span> : null}
                    </div>
                  );
                })}
                <div style={{ height: virtual.windowState.bottom }} />
              </div>
            )}
          </div>
        </div>
        {actionMenuState ? (
          <div
            className="fixed z-[80] min-w-[160px] rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] p-1 shadow-apple-lg"
            style={{ left: actionMenuState.x, top: actionMenuState.y }}
            data-action-group={actionGroups.popupActionGroupId}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {kind === "ignored" ? (
              <button
                type="button"
                disabled={!dataSnapshot.canDelete}
                className="flex w-full items-center rounded-apple-sm px-2 py-1 text-left text-xs hover:bg-[var(--cf-surface-hover)]"
                onClick={() => {
                  setActionMenuState(null);
                  void runCurrentActionAsync("delete");
                }}
              >
                {gt("specialFilesDialog.actions.delete", "删除")}
              </button>
            ) : kind === "unversioned" ? (
              <>
                <button
                  type="button"
                  disabled={!dataSnapshot.canAddToVcs}
                  className="flex w-full items-center rounded-apple-sm px-2 py-1 text-left text-xs hover:bg-[var(--cf-surface-hover)]"
                  onClick={() => {
                    setActionMenuState(null);
                    void runCurrentActionAsync("stage");
                  }}
                >
                  {gt("workbench.changes.context.addToVcs", "添加到 VCS")}
                </button>
                <button
                  type="button"
                  disabled={!dataSnapshot.canAddToVcs}
                  className="flex w-full items-center rounded-apple-sm px-2 py-1 text-left text-xs hover:bg-[var(--cf-surface-hover)]"
                  onClick={() => {
                    setActionMenuState(null);
                    void runCurrentActionAsync("ignore");
                  }}
                >
                  {gt("workbench.changes.context.ignore", "忽略")}
                </button>
              </>
            ) : kind === "conflict" ? (
              <button
                type="button"
                disabled={selectedPaths.length === 0}
                className="flex w-full items-center rounded-apple-sm px-2 py-1 text-left text-xs hover:bg-[var(--cf-surface-hover)]"
                onClick={() => {
                  setActionMenuState(null);
                  void runCurrentActionAsync("open");
                }}
              >
                {gt("specialFilesDialog.actions.resolveSelectedConflicts", "解决选中冲突")}
              </button>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
