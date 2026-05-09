// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { interpolateI18nText } from "@/lib/translate";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileCode2,
  Folder,
  RefreshCcw,
  Search,
} from "lucide-react";
import {
  buildCommitDetailsActionGroups,
  resolveCommitDetailsSelectionHashResolution,
  type GitCommitDetailsBrowserActionKey,
} from "./detail-actions";
import { ContextMenu, ContextMenuItem, renderContextMenuSections, type GitContextMenuState } from "./context-menu";
import type { GitCommitDetailsActionAvailability, GitLogDetails } from "./types";

const TREE_DEPTH_INDENT = 18;
const DETAIL_TREE_BASE_PADDING = 12;

export type GitDetailsBrowserTreeNode = {
  key: string;
  name: string;
  fullPath: string;
  isFile: boolean;
  count: number;
  status?: string;
  oldPath?: string;
  filePaths: string[];
};

type GitCommitLineStatsSummary = {
  additionsText: string;
  deletionsText: string;
  totalText: string;
  netText: string;
  netDirection: "increase" | "decrease" | "neutral";
};

type GitDetailsBrowserProps = {
  details: GitLogDetails | null;
  detailFilesFlat: string[];
  detailFileRows: Array<{ node: GitDetailsBrowserTreeNode; depth: number }>;
  detailCountMap: Map<string, number>;
  selectedDetailNodeKeys: string[];
  selectedDetailPaths: string[];
  selectedDetailPrimaryPath: string;
  detailTreeExpanded: Record<string, boolean>;
  detailSpeedSearch: string;
  detailSpeedSearchOpen: boolean;
  activeDetailHash: string;
  showParentChanges: boolean;
  detailActionAvailability: GitCommitDetailsActionAvailability | null;
  detailLineStatsSummary: GitCommitLineStatsSummary | null;
  orderedSelectedCommitHashesNewestFirst: string[];
  orderedSelectedCommitHashesOldestFirst: string[];
  speedSearchRootRef: React.RefObject<HTMLDivElement>;
  containerRef: React.RefObject<HTMLDivElement>;
  renderSpeedSearchText(text: string, query: string): React.ReactNode;
  resolveDetailPathCommitHashes(targetPath: string, fallbackHashes?: string[]): string[];
  toCommitFileStatusText(status: string): string;
  toLocalDateText(value: string): string;
  resolveStatusToneClassName(status?: string): string;
  onExpandAll(): void;
  onCollapseAll(): void;
  onFocus(): void;
  onBlur(event: React.FocusEvent<HTMLDivElement>): void;
  onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void;
  onMouseDown(): void;
  onSpeedSearchChange(nextQuery: string): void;
  onMoveSpeedSearchMatch(direction: "next" | "previous"): void;
  onResetSpeedSearch(options?: { restoreFocus?: boolean }): void;
  onSelectNode(nodeKey: string, event: React.MouseEvent<HTMLButtonElement>): void;
  onToggleExpanded(nodeKey: string): void;
  onEnsureSelected(nodeKey: string): void;
  onOpenDiff(path: string, hash: string, hashes?: string[]): void;
  onRunAction(action: GitCommitDetailsBrowserActionKey, targetPath: string, targetHash?: string, targetPaths?: string[], targetHashes?: string[]): void;
  onRefresh(): void;
  onToggleShowParentChanges(): void;
};

type GitDetailsBrowserMenuState = GitContextMenuState & {
  targetPath: string;
  targetKind: "file" | "folder";
};

/**
 * 独立渲染 committed changes details browser，统一承接选择、Diff 同步、toolbar 与 popup。
 */
export function GitDetailsBrowser(props: GitDetailsBrowserProps): JSX.Element {
  const { t } = useTranslation(["git", "common"]);
  const {
    details,
    detailFilesFlat,
    detailFileRows,
    detailCountMap,
    selectedDetailNodeKeys,
    selectedDetailPaths,
    detailTreeExpanded,
    detailSpeedSearch,
    detailSpeedSearchOpen,
    activeDetailHash,
    showParentChanges,
    detailActionAvailability,
    detailLineStatsSummary,
    orderedSelectedCommitHashesNewestFirst,
    orderedSelectedCommitHashesOldestFirst,
    speedSearchRootRef,
    containerRef,
    renderSpeedSearchText,
    resolveDetailPathCommitHashes,
    toCommitFileStatusText,
    toLocalDateText,
    resolveStatusToneClassName,
    onExpandAll,
    onCollapseAll,
    onFocus,
    onBlur,
    onKeyDown,
    onMouseDown,
    onSpeedSearchChange,
    onMoveSpeedSearchMatch,
    onResetSpeedSearch,
    onSelectNode,
    onToggleExpanded,
    onEnsureSelected,
    onOpenDiff,
    onRunAction,
    onRefresh,
    onToggleShowParentChanges,
  } = props;
  const gt = React.useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return interpolateI18nText(String(t(key, {
      ns: "git",
      defaultValue: fallback,
      ...(values || {}),
    })), values);
  }, [t]);
  const [menu, setMenu] = useState<GitDetailsBrowserMenuState | null>(null);
  const speedSearchInputRef = useRef<HTMLInputElement>(null);
  const actionGroups = useMemo(
    () => buildCommitDetailsActionGroups(detailActionAvailability, (key, fallback) => gt(key, fallback)),
    [detailActionAvailability, gt],
  );
  const detailSpeedSearchQuery = detailSpeedSearch.trim();

  /**
   * 判断焦点是否仍停留在提交详情整体面板内，供树容器与搜索输入框共享失焦豁免。
   */
  const isFocusWithinPane = (target: Node | null): boolean => {
    const root = speedSearchRootRef.current;
    return !!root && !!target && root.contains(target);
  };

  /**
   * 同步提交详情 speed search 输入框内容，沿用父级现有的匹配与选区联动逻辑。
   */
  const handleSpeedSearchInputChange = (nextQuery: string): void => {
    onSpeedSearchChange(nextQuery);
  };

  /**
   * 统一处理提交详情 speed search 输入框快捷键，避免字符键再冒泡回树容器造成双写。
   */
  const handleSpeedSearchInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    event.stopPropagation();
    if (event.key === "F3") {
      event.preventDefault();
      onMoveSpeedSearchMatch(event.shiftKey ? "previous" : "next");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onResetSpeedSearch({ restoreFocus: true });
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.currentTarget.select();
    }
  };

  /**
   * 在点击详情树时优先把焦点收回滚动容器，保证后续字符键与 Ctrl+F 继续生效。
   */
  const handleTreeMouseDown = (): void => {
    containerRef.current?.focus();
    onMouseDown();
  };

  useEffect(() => {
    if (!detailSpeedSearchOpen) return;
    const input = speedSearchInputRef.current;
    if (!input) return;
    input.focus();
    const caret = input.value.length;
    input.setSelectionRange(caret, caret);
  }, [detailSpeedSearchOpen]);

  /**
   * 根据右键命中的节点与当前树选区推导动作目标文件；若命中节点已在选区内，则复用整个选区，对齐 IDEA 基于 `getSelectedChanges()` 的批量执行语义。
   */
  const resolveTargetFiles = (targetPath: string): string[] => {
    const normalizedTargetPath = String(targetPath || "").trim();
    const row = detailFileRows.find((item) => item.node.fullPath === normalizedTargetPath);
    const normalizedSelectionFiles = (selectedDetailPaths || [])
      .map((pathText) => String(pathText || "").trim())
      .filter(Boolean);
    const targetInSelection = !!row?.node.key && selectedDetailNodeKeys.includes(row.node.key);
    if (normalizedSelectionFiles.length > 0 && (!normalizedTargetPath || targetInSelection))
      return Array.from(new Set(normalizedSelectionFiles));
    if (!row) return normalizedTargetPath ? [normalizedTargetPath] : [];
    const targetFiles = row.node.isFile ? [row.node.fullPath] : row.node.filePaths;
    return Array.from(new Set(targetFiles.map((pathText) => String(pathText || "").trim()).filter(Boolean)));
  };

  /**
   * 统一为详情树动作解析文件、提交与禁用状态；文件集合优先复用当前选区，避免多选右键时退化为单节点执行。
   */
  const resolveTargetContext = (targetPath: string, targetKind: "file" | "folder"): {
    targetFiles: string[];
    targetCommitHashes: string[];
    targetHash: string;
    hashResolution: ReturnType<typeof resolveCommitDetailsSelectionHashResolution>;
    noFiles: boolean;
  } => {
    const targetFiles = resolveTargetFiles(targetPath);
    const hashResolution = resolveCommitDetailsSelectionHashResolution(targetFiles, (filePath) => resolveDetailPathCommitHashes(filePath));
    const targetCommitHashSet = new Set(hashResolution.uniqueHashes);
    const targetCommitHashes = orderedSelectedCommitHashesOldestFirst.filter((hash) => targetCommitHashSet.has(hash));
    const orderedHashes = targetCommitHashes.length > 0 ? targetCommitHashes : hashResolution.uniqueHashes;
    const targetHash = details?.mode === "single"
      ? details.detail.hash
      : (orderedHashes[orderedHashes.length - 1] || orderedSelectedCommitHashesNewestFirst[0] || "");
    return {
      targetFiles,
      targetCommitHashes: orderedHashes,
      targetHash,
      hashResolution,
      noFiles: targetKind !== "file" ? targetFiles.length <= 0 : targetFiles.length === 0,
    };
  };

  const resolveActionMeta = (
    actionId: GitCommitDetailsBrowserActionKey,
    targetPath: string,
    targetKind: "file" | "folder",
  ): { disabled: boolean; title?: string } => {
    const context = resolveTargetContext(targetPath, targetKind);
    const noFiles = context.noFiles;
    const uniqueHashes = context.hashResolution.uniqueHashes;
    const singleHashContext = uniqueHashes.length === 1;
    const compareRevisionsContext = uniqueHashes.length === 2;
    const allPathsHaveSingleHash = context.hashResolution.allPathsHaveSingleHash;
    const flattened = actionGroups.flatMap((group) => group.items);
    const item = flattened.find((candidate) => candidate.id === actionId);
    if (!targetPath) return { disabled: true, title: gt("details.browser.messages.noSelection", "未选择变更") };
    if (actionId === "showDiff") return { disabled: noFiles || !context.targetHash };
    if (actionId === "compareRevisions")
      return {
        disabled: noFiles || !compareRevisionsContext,
        title: !noFiles && !compareRevisionsContext
          ? gt("details.actions.compareRevisionsTwoCommits", "仅支持恰好两个提交的版本比较")
          : undefined,
      };
    if (actionId === "compareLocal" || actionId === "comparePreviousLocal")
      return {
        disabled: noFiles || !singleHashContext,
        title: !noFiles && !singleHashContext ? gt("details.browser.messages.multiCommitUnsupported", "多选提交聚合详情暂不支持") : undefined,
      };
    if (actionId === "createPatch") return { disabled: noFiles };
    if (actionId === "openRepositoryVersion")
      return {
        disabled: noFiles || item?.enabled === false || !allPathsHaveSingleHash,
        title: item?.enabled === false
          ? item.reason
          : (!noFiles && !allPathsHaveSingleHash
            ? gt("details.actions.selectionMustResolveToSingleCommit", "当前选择中的文件必须各自唯一映射到一个提交")
            : undefined),
      };
    if (actionId === "restoreFromRevision")
      return {
        disabled: noFiles || !allPathsHaveSingleHash,
        title: !noFiles && !allPathsHaveSingleHash
          ? gt("details.actions.selectionMustResolveToSingleCommit", "当前选择中的文件必须各自唯一映射到一个提交")
          : undefined,
      };
    if (actionId === "pathHistory") {
      if (targetKind !== "file")
        return { disabled: true, title: gt("details.browser.messages.pathHistorySingleFile", "仅支持单提交详情中的单个文件") };
      if (!singleHashContext)
        return { disabled: true, title: gt("details.browser.messages.multiCommitUnsupported", "多选提交聚合详情暂不支持") };
      if (context.targetFiles.length !== 1)
        return { disabled: true, title: gt("details.browser.messages.pathHistorySingleFile", "仅支持单提交详情中的单个文件") };
      return {
        disabled: noFiles || item?.enabled === false,
        title: item?.reason,
      };
    }
    if (actionId === "toggleParentChanges") return { disabled: false };
    return {
      disabled: item?.enabled === false,
      title: item?.reason,
    };
  };

  /**
   * 执行详情树右键动作；除“显示对父项的更改”外，其余动作都携带已解析好的目标文件集合，供外层按同一上下文落地。
   */
  const runAction = (actionId: GitCommitDetailsBrowserActionKey, targetPath: string, targetKind: "file" | "folder"): void => {
    if (!targetPath) return;
    if (actionId === "toggleParentChanges") {
      onToggleShowParentChanges();
      setMenu(null);
      return;
    }
    const context = resolveTargetContext(targetPath, targetKind);
    onRunAction(actionId, targetPath, context.targetHash, context.targetFiles, context.targetCommitHashes);
    setMenu(null);
  };

  return (
    <>
      <div className="flex min-h-0 flex-col overflow-hidden">
        <div className="cf-git-pane-header sticky top-0 z-10 flex items-center justify-between border-b border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple px-1.5 py-[3px]">
          <span>{gt("details.browser.title", "提交详情")}</span>
          <div className="flex items-center gap-1">
            <Button size="icon-sm" variant="ghost" onClick={onRefresh} title={gt("details.browser.toolbar.refresh", "刷新详情")}>
              <RefreshCcw className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={onExpandAll} title={gt("details.browser.toolbar.expandAll", "全部展开")}>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={onCollapseAll} title={gt("details.browser.toolbar.collapseAll", "全部收起")}>
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        {!details ? <div className="cf-git-empty-panel p-2 text-xs text-[var(--cf-text-secondary)]">{gt("details.browser.empty", "未选择的提交")}</div> : null}
        {details ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* 当前产品设计要求把“提交详情”面板顶部工具栏内的重复动作统一收敛到右键菜单，顶部不再重复渲染同名按钮；
                原因是右键已提供等价功能，继续平铺会造成重复操作入口。设计如此，此处在“提交详情顶部工具栏”范围内继续不对齐 IDEA。 */}
            <div ref={speedSearchRootRef} className="relative min-h-0 flex-[1.1] border-b border-[var(--cf-border)]">
              {detailSpeedSearchOpen ? (
                <div
                  data-testid="details-browser-speed-search"
                  className="absolute left-3 top-3 z-20 flex max-w-[calc(100%-24px)] items-center gap-1 rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-2 py-1 text-xs shadow-apple-md"
                >
                  <Search className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                  <input
                    ref={speedSearchInputRef}
                    data-testid="details-browser-speed-search-input"
                    type="text"
                    value={detailSpeedSearch}
                    placeholder={gt("details.browser.searchPlaceholder", "搜索")}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="min-w-[32px] flex-1 bg-transparent text-xs text-[var(--cf-text-primary)] outline-none placeholder:text-[var(--cf-text-secondary)]"
                    onChange={(event) => {
                      handleSpeedSearchInputChange(event.target.value);
                    }}
                    onKeyDown={handleSpeedSearchInputKeyDown}
                    onBlur={(event) => {
                      const nextTarget = event.relatedTarget as Node | null;
                      if (isFocusWithinPane(nextTarget)) return;
                      onResetSpeedSearch();
                    }}
                  />
                </div>
              ) : null}
              <div
                ref={containerRef}
                className="min-h-0 h-full overflow-auto cf-scroll-area px-1 py-1 outline-none"
                tabIndex={0}
                onFocus={onFocus}
                onBlur={onBlur}
                onMouseDown={handleTreeMouseDown}
                onKeyDown={onKeyDown}
              >
                <div className="mb-1 px-1 text-[11px] text-[var(--cf-text-secondary)]">
                  {gt("details.browser.fileCount", "变更文件 {{count}} 个", { count: detailFilesFlat.length })}
                  {selectedDetailNodeKeys.length > 0 ? gt("details.browser.selectedCount", "，已选中 {{count}} 个", { count: selectedDetailNodeKeys.length }) : ""}
                </div>
                {detailFileRows.map(({ node, depth }) => {
                  const selected = selectedDetailNodeKeys.includes(node.key);
                  const expanded = detailTreeExpanded[node.key] !== false;
                  const statusText = node.isFile ? toCommitFileStatusText(node.status || "") : "";
                  const nodeCommitHashes = node.isFile ? resolveDetailPathCommitHashes(node.fullPath) : [];
                  const nodePrimaryHash = nodeCommitHashes[nodeCommitHashes.length - 1] || activeDetailHash;
                  return (
                    <button
                      key={node.key}
                      className={cn(
                        "cf-git-tree-row flex w-full items-center gap-0 rounded-apple-sm px-1 py-[1px] text-left text-xs",
                        selected ? "cf-git-row-selected" : "",
                      )}
                      style={{ paddingLeft: DETAIL_TREE_BASE_PADDING + depth * TREE_DEPTH_INDENT }}
                      onClick={(event) => {
                        onSelectNode(node.key, event);
                        if (node.isFile && !event.ctrlKey && !event.metaKey && !event.shiftKey && nodePrimaryHash)
                          onOpenDiff(node.fullPath, nodePrimaryHash, nodeCommitHashes.length > 1 ? nodeCommitHashes : undefined);
                      }}
                      onDoubleClick={() => {
                        if (!node.isFile) {
                          onToggleExpanded(node.key);
                          return;
                        }
                        if (nodePrimaryHash)
                          onOpenDiff(node.fullPath, nodePrimaryHash, nodeCommitHashes.length > 1 ? nodeCommitHashes : undefined);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onEnsureSelected(node.key);
                        setMenu({
                          x: event.clientX,
                          y: event.clientY,
                          targetPath: node.fullPath,
                          targetKind: node.isFile ? "file" : "folder",
                        });
                      }}
                    >
                      {node.isFile ? (
                        <>
                          <span className="h-3.5 w-3.5 shrink-0" />
                          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[var(--cf-accent)] opacity-90" />
                        </>
                      ) : (
                        <>
                          <span
                            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-apple-sm hover:bg-[var(--cf-surface-hover)]"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              onToggleExpanded(node.key);
                            }}
                            title={expanded ? gt("details.browser.tree.collapse", "收起") : gt("details.browser.tree.expand", "展开")}
                          >
                            {expanded ? <ChevronDown className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" /> : <ChevronRight className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />}
                          </span>
                          <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--cf-text-secondary)]" />
                        </>
                      )}
                      {node.isFile ? (
                        <span className={cn("cf-git-status-badge mr-1 w-10 shrink-0 text-center text-[10px] leading-none", resolveStatusToneClassName(node.status))}>
                          {statusText}
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate" title={node.name}>
                        {detailSpeedSearchQuery ? renderSpeedSearchText(node.name, detailSpeedSearchQuery) : node.name}
                      </span>
                      {!node.isFile ? <span className="ml-0.5 shrink-0 text-[10px] text-[var(--cf-text-secondary)]">{gt("details.browser.tree.nodeFileCount", "{{count}} 个文件", { count: node.count })}</span> : null}
                      {node.isFile && details.mode === "multiple" ? (
                        <span className="ml-auto shrink-0 text-[10px] text-[var(--cf-text-secondary)]">{detailCountMap.get(node.fullPath) || 1}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
              {details.mode === "multiple" ? (
                <div className="cf-git-meta-card space-y-1 text-[11px] text-[var(--cf-text-secondary)]">
                  <div className="text-xs font-medium text-[var(--cf-text-primary)]">{gt("details.browser.summary.selectedCommits", "已选择 {{count}} 个提交", { count: details.selectedCount })}</div>
                  <div>{gt("details.browser.summary.fileUnion", "文件并集：{{count}} 项", { count: details.files.length })}</div>
                  <div>{gt("details.browser.summary.hint", "提示：双击文件可在中间区域打开 Diff。")}</div>
                </div>
              ) : (
                <>
                  <div className="cf-git-meta-card">
                    <div className="mb-2 text-xs font-apple-semibold text-[var(--cf-text-primary)]">{details.detail.subject}</div>
                    <div className="space-y-1.5 text-[11px] text-[var(--cf-text-secondary)]">
                      <div className="flex items-start gap-2">
                        <span className="cf-git-meta-label">{gt("details.browser.meta.hash", "Hash")}</span>
                        <span className="min-w-0 break-all font-mono text-[var(--cf-text-primary)]">{details.detail.hash}</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="cf-git-meta-label">{gt("details.browser.meta.author", "作者")}</span>
                        <span className="min-w-0 break-all">{details.detail.authorName} &lt;{details.detail.authorEmail}&gt;</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="cf-git-meta-label">{gt("details.browser.meta.date", "日期")}</span>
                        <span>{toLocalDateText(details.detail.authorDate)}</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="cf-git-meta-label">{gt("details.browser.meta.branches", "分支")}</span>
                        <span className="cf-git-ref-pills">
                          {details.detail.branches.length > 0
                            ? details.detail.branches.map((branchName) => (
                                <span key={`detail-branch:${branchName}`} className="cf-git-ref-pill cf-git-tone-info">
                                  {branchName}
                                </span>
                              ))
                            : <span className="cf-git-ref-pill cf-git-tone-muted">—</span>}
                        </span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="cf-git-meta-label">{gt("details.browser.meta.tags", "标签")}</span>
                        <span className="cf-git-ref-pills">
                          {details.detail.tags.length > 0
                            ? details.detail.tags.map((tagName) => (
                                <span key={`detail-tag:${tagName}`} className="cf-git-ref-pill cf-git-tone-warning">
                                  {tagName}
                                </span>
                              ))
                            : <span className="cf-git-ref-pill cf-git-tone-muted">—</span>}
                        </span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="cf-git-meta-label">{gt("details.browser.meta.lineStats", "行变更")}</span>
                        <span className="flex flex-wrap items-center gap-2 font-mono">
                          <span className="text-[var(--cf-green)]">{detailLineStatsSummary?.additionsText || "+0"}</span>
                          <span className="text-[var(--cf-red)]">{detailLineStatsSummary?.deletionsText || "-0"}</span>
                          <span className="text-[var(--cf-text-secondary)]">{detailLineStatsSummary?.totalText || gt("details.browser.meta.totalLinesFallback", "共 0 行")}</span>
                          <span
                            className={cn(
                              detailLineStatsSummary?.netDirection === "increase"
                                ? "text-[var(--cf-green)]"
                                : detailLineStatsSummary?.netDirection === "decrease"
                                  ? "text-[var(--cf-red)]"
                                  : "text-[var(--cf-text-secondary)]",
                            )}
                          >
                            {detailLineStatsSummary?.netText || gt("details.browser.meta.netLinesFallback", "净变化 0 行")}
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>
                  {details.detail.body?.trim() ? (
                    <div className="cf-git-inline-card mt-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] p-2 text-[11px] whitespace-pre-wrap">
                      {details.detail.body.trim()}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ) : null}
      </div>

      <ContextMenu menu={menu} onClose={() => setMenu(null)} actionGroupId="git.details.browser.popup">
        {renderContextMenuSections(actionGroups.map((group) => group.items.map((action) => {
          const meta = menu ? resolveActionMeta(action.id, menu.targetPath, menu.targetKind) : {
            disabled: true,
            title: gt("details.browser.messages.noSelection", "未选择变更"),
          };
          return (
            <ContextMenuItem
              key={`${group.id}:${action.id}`}
              label={action.label}
              shortcut={action.shortcut}
              disabled={meta.disabled}
              title={meta.title}
              tone={action.tone}
              checked={action.id === "toggleParentChanges" ? showParentChanges : undefined}
              onClick={() => {
                if (!menu) return;
                runAction(action.id, menu.targetPath, menu.targetKind);
              }}
            />
          );
        })))}
      </ContextMenu>
    </>
  );
}
