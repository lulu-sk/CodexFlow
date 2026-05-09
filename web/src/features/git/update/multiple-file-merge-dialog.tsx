// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CheckSquare,
  ExternalLink,
  FileCode2,
  Folder,
  Loader2,
  Play,
  RefreshCcw,
  SkipForward,
  Square,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { interpolateI18nText } from "@/lib/translate";
import type {
  GitConflictMergeSessionEntry,
  GitConflictMergeSessionSnapshot,
} from "../types";
import {
  buildAcceptConflictSideActionLabel,
  buildMergeConflictTableRows,
  findMergeConflictAncestorNodeKeys,
  formatMergeConflictSideState,
  getSelectedMergeConflictEntry,
  resolveEffectiveMergeConflictPaths,
  resolveMergeConflictPrimaryAction,
} from "./merge-conflict-manager";

type GitRepositoryOperationState = "normal" | "rebasing" | "merging" | "grafting" | "reverting";
type LabelResolver = (key: string, fallback: string, values?: Record<string, unknown>) => string;

type MultipleFileMergeDialogProps = {
  open: boolean;
  title: string;
  description: string;
  snapshot: GitConflictMergeSessionSnapshot | null;
  selectedPath: string;
  checkedPaths: string[];
  groupByDirectory: boolean;
  showResolved: boolean;
  operationState?: GitRepositoryOperationState;
  loading?: boolean;
  submitting: "continue" | "abort" | null;
  applyingSide: "ours" | "theirs" | null;
  onOpenChange(open: boolean): void;
  onSelectPath(path: string): void;
  onTogglePath(path: string, checked: boolean): void;
  onToggleAll(checked: boolean): void;
  onToggleGroupByDirectory(): void;
  onToggleShowResolved(): void;
  onOpenSelected(): void;
  onOpenSelectedInIde?(): void;
  onOpenSelectedInSystem?(): void;
  onShowInCommitPanel?(): void;
  onRefresh(): void;
  onSelectNext(): void;
  onApplySide(side: "ours" | "theirs"): void;
  continueLabel?: string;
  onContinue?(): void;
  onAbort?(): void;
};

/**
 * 把仓库进行中状态映射为简短角标文案，供多文件 merge 对话框复用。
 */
function getOperationStateBadge(state?: GitRepositoryOperationState, resolveLabel?: LabelResolver): string | null {
  if (!state || state === "normal") return null;
  if (state === "rebasing") {
    return resolveLabel
      ? resolveLabel("dialogs.multipleFileMerge.operationStates.rebasing", "Rebase")
      : "Rebase";
  }
  if (state === "merging") {
    return resolveLabel
      ? resolveLabel("dialogs.multipleFileMerge.operationStates.merging", "Merge")
      : "Merge";
  }
  if (state === "grafting") {
    return resolveLabel
      ? resolveLabel("dialogs.multipleFileMerge.operationStates.grafting", "Cherry-pick")
      : "Cherry-pick";
  }
  return resolveLabel
    ? resolveLabel("dialogs.multipleFileMerge.operationStates.reverting", "Revert")
    : "Revert";
}

/**
 * 根据单个 merge session 条目生成状态 badge 列，统一承载 resolved/binary/tooLarge/reverse 等信号。
 */
function buildMergeSessionBadges(entry: GitConflictMergeSessionEntry, resolveLabel?: LabelResolver): string[] {
  const badges: string[] = [];
  if (entry.conflictState === "resolved") {
    badges.push(resolveLabel ? resolveLabel("dialogs.multipleFileMerge.badges.resolved", "已解决") : "已解决");
  }
  if (entry.conflictState === "unresolved" && entry.canOpenMerge) {
    badges.push(resolveLabel ? resolveLabel("dialogs.multipleFileMerge.badges.openableMerge", "应用内合并") : "应用内合并");
  }
  if ([entry.base, entry.ours, entry.theirs, entry.working].some((one) => one.isBinary)) {
    badges.push(resolveLabel ? resolveLabel("dialogs.multipleFileMerge.badges.binary", "二进制") : "二进制");
  }
  if ([entry.base, entry.ours, entry.theirs, entry.working].some((one) => one.tooLarge)) {
    badges.push(resolveLabel ? resolveLabel("dialogs.multipleFileMerge.badges.tooLarge", "文件过大") : "文件过大");
  }
  if (entry.reverseSides) {
    badges.push(resolveLabel ? resolveLabel("dialogs.multipleFileMerge.badges.reverseSides", "已反转冲突侧") : "已反转冲突侧");
  }
  if (badges.length <= 0) {
    badges.push(resolveLabel ? resolveLabel("dialogs.multipleFileMerge.badges.openable", "可打开") : "可打开");
  }
  return badges;
}

/**
 * 把单个 revision 元数据转为详情区短提示，避免 UI 层散落 binary/tooLarge 规则。
 */
function getMergeSessionRevisionStateText(
  label: string,
  revision: GitConflictMergeSessionEntry["base"],
  resolveLabel?: LabelResolver,
): string {
  if (revision.isBinary) {
    return resolveLabel ? resolveLabel("dialogs.multipleFileMerge.revisionState.binary", "{{label}}：二进制", { label }) : `${label}：二进制`;
  }
  if (revision.tooLarge) {
    return resolveLabel ? resolveLabel("dialogs.multipleFileMerge.revisionState.tooLarge", "{{label}}：文件过大", { label }) : `${label}：文件过大`;
  }
  if (revision.available) {
    return resolveLabel ? resolveLabel("dialogs.multipleFileMerge.revisionState.available", "{{label}}：可用", { label }) : `${label}：可用`;
  }
  return resolveLabel ? resolveLabel("dialogs.multipleFileMerge.revisionState.unavailable", "{{label}}：不可用", { label }) : `${label}：不可用`;
}

/**
 * 根据当前选区计算表格副标题，统一提示批量采用动作会落到哪些文件上。
 */
function buildMergeConflictSelectionSummary(args: {
  effectivePaths: string[];
  selectedEntry: GitConflictMergeSessionEntry | null;
  resolveLabel?: LabelResolver;
}): string {
  if (args.effectivePaths.length > 1) {
    return args.resolveLabel
      ? args.resolveLabel("dialogs.multipleFileMerge.summary.batch", "批量操作将作用于 {{count}} 个未解决文件", { count: args.effectivePaths.length })
      : `批量操作将作用于 ${args.effectivePaths.length} 个未解决文件`;
  }
  if (args.effectivePaths.length === 1) {
    return args.resolveLabel
      ? args.resolveLabel("dialogs.multipleFileMerge.summary.single", "未勾选时，批量操作会作用于当前选中的未解决文件")
      : "未勾选时，批量操作会作用于当前选中的未解决文件";
  }
  if (args.selectedEntry?.conflictState === "resolved") {
    return args.resolveLabel
      ? args.resolveLabel("dialogs.multipleFileMerge.summary.resolved", "当前选中的是已解决文件，可继续打开复查结果")
      : "当前选中的是已解决文件，可继续打开复查结果";
  }
  return args.resolveLabel
    ? args.resolveLabel("dialogs.multipleFileMerge.summary.prompt", "请选择一个未解决文件，或先勾选多个文件后再执行批量采用")
    : "请选择一个未解决文件，或先勾选多个文件后再执行批量采用";
}

/**
 * 整理右侧详情区的主操作说明，避免 JSX 中散落 merge/open 文案判断。
 */
function buildMergeConflictPrimaryActionDescription(args: {
  entry: GitConflictMergeSessionEntry | null;
  primaryAction: { label: string; enabled: boolean };
  resolveLabel?: LabelResolver;
}): string {
  if (!args.entry) {
    return args.resolveLabel
      ? args.resolveLabel("dialogs.multipleFileMerge.details.noSelection", "当前没有选中文件。")
      : "当前没有选中文件。";
  }
  if (!args.primaryAction.enabled) {
    return args.resolveLabel
      ? args.resolveLabel("dialogs.multipleFileMerge.details.primaryActionDisabled", "当前文件暂时不可执行主操作。")
      : "当前文件暂时不可执行主操作。";
  }
  if (args.entry.conflictState === "resolved") {
    return args.resolveLabel
      ? args.resolveLabel("dialogs.multipleFileMerge.details.primaryActionResolved", "主操作：{{label}}（复查当前结果）", { label: args.primaryAction.label })
      : `主操作：${args.primaryAction.label}（复查当前结果）`;
  }
  if (args.entry.canOpenMerge) {
    return args.resolveLabel
      ? args.resolveLabel("dialogs.multipleFileMerge.details.primaryActionMerge", "主操作：{{label}}（进入应用内三方合并）", { label: args.primaryAction.label })
      : `主操作：${args.primaryAction.label}（进入应用内三方合并）`;
  }
  return args.resolveLabel
    ? args.resolveLabel("dialogs.multipleFileMerge.details.primaryActionExternal", "主操作：{{label}}（交给外部 IDE 或系统默认程序处理）", { label: args.primaryAction.label })
    : `主操作：${args.primaryAction.label}（交给外部 IDE 或系统默认程序处理）`;
}

/**
 * 把当前仓库冲突状态翻译为顶部提示文案，尽量贴近 IDEA resolver 的说明密度。
 */
function buildMergeConflictScopeHint(snapshot: GitConflictMergeSessionSnapshot | null, resolveLabel?: LabelResolver): string {
  if (snapshot?.reverseSides) {
    return resolveLabel
      ? resolveLabel("dialogs.multipleFileMerge.scopeHint.reverseSides", "当前仓库使用反转冲突侧语义，左/右来源与接受动作已按当前映射规则校正。")
      : "当前仓库使用反转冲突侧语义，左/右来源与接受动作已按当前映射规则校正。";
  }
  return resolveLabel
    ? resolveLabel("dialogs.multipleFileMerge.scopeHint.default", "左侧集中浏览冲突文件，右侧执行接受某一侧更改、合并或外部打开等操作。")
    : "左侧集中浏览冲突文件，右侧执行接受某一侧更改、合并或外部打开等操作。";
}

/**
 * 格式化目录节点摘要，沿用提交面板的树节点聚合语义展示当前目录下的文件数量。
 */
function formatMergeConflictDirectorySummary(fileCount: number, resolveLabel?: LabelResolver): string {
  const normalizedCount = Math.max(0, Math.floor(Number(fileCount) || 0));
  return resolveLabel
    ? resolveLabel("dialogs.multipleFileMerge.directorySummary", "{{count}} 个文件", { count: normalizedCount })
    : `${normalizedCount} 个文件`;
}

/**
 * 渲染接近 IDEA MultipleFileMergeDialog 的多文件冲突总线 UI，统一承载表格、目录分组与主操作按钮。
 */
export function MultipleFileMergeDialog(props: MultipleFileMergeDialogProps): React.ReactElement {
  const { t } = useTranslation("git");
  const [treeExpanded, setTreeExpanded] = useState<Record<string, boolean>>({});
  const gt = React.useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return interpolateI18nText(String(t(key, {
      ns: "git",
      defaultValue: fallback,
      ...(values || {}),
    })), values);
  }, [t]);
  const snapshot = props.snapshot;
  const selectedEntry = useMemo(
    () => getSelectedMergeConflictEntry(snapshot, props.selectedPath),
    [props.selectedPath, snapshot],
  );
  const unresolvedPathSet = useMemo(
    () => new Set((snapshot?.unresolvedEntries || []).map((entry) => entry.path)),
    [snapshot?.unresolvedEntries],
  );
  const tableRows = useMemo(() => {
    return buildMergeConflictTableRows({
      snapshot,
      groupByDirectory: props.groupByDirectory,
      showResolved: props.showResolved,
      expanded: treeExpanded,
      resolveLabel: gt,
    });
  }, [gt, props.groupByDirectory, props.showResolved, snapshot, treeExpanded]);
  const checkedPathSet = useMemo(() => new Set(props.checkedPaths), [props.checkedPaths]);
  const allChecked = useMemo(() => {
    const unresolvedEntries = snapshot?.unresolvedEntries || [];
    return unresolvedEntries.length > 0 && unresolvedEntries.every((entry) => checkedPathSet.has(entry.path));
  }, [checkedPathSet, snapshot?.unresolvedEntries]);
  const effectivePaths = useMemo(() => {
    return resolveEffectiveMergeConflictPaths({
      snapshot,
      selectedPath: props.selectedPath,
      checkedPaths: props.checkedPaths,
    });
  }, [props.checkedPaths, props.selectedPath, snapshot]);
  const operationBadge = getOperationStateBadge(props.operationState, gt);
  const primaryAction = resolveMergeConflictPrimaryAction(selectedEntry, gt);
  const canApplySide = effectivePaths.length > 0 && props.submitting === null && props.applyingSide === null;
  const canOpenFallback = !!selectedEntry && props.submitting === null && props.applyingSide === null;
  const canContinue = !!props.onContinue
    && (snapshot?.unresolvedCount || 0) <= 0
    && props.submitting === null
    && props.applyingSide === null;
  const canAbort = !!props.onAbort && props.submitting === null && props.applyingSide === null;
  const selectionSummary = buildMergeConflictSelectionSummary({
    effectivePaths,
    selectedEntry,
    resolveLabel: gt,
  });
  const primaryActionDescription = buildMergeConflictPrimaryActionDescription({
    entry: selectedEntry,
    primaryAction,
    resolveLabel: gt,
  });

  useEffect(() => {
    if (!props.groupByDirectory) return;
    const ancestorKeys = findMergeConflictAncestorNodeKeys({
      snapshot,
      selectedPath: props.selectedPath,
      showResolved: props.showResolved,
    });
    if (ancestorKeys.length <= 0) return;
    setTreeExpanded((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of ancestorKeys) {
        if (next[key] === false) {
          next[key] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [props.groupByDirectory, props.selectedPath, props.showResolved, snapshot]);

  /**
   * 切换目录节点展开态，未显式折叠的节点默认视为展开，与提交面板保持一致。
   */
  const toggleDirectoryNodeExpanded = (nodeKey: string): void => {
    setTreeExpanded((prev) => ({
      ...prev,
      [nodeKey]: prev[nodeKey] === false,
    }));
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="h-[min(88vh,820px)] w-[min(1180px,calc(100vw-24px))] max-w-[1180px] overflow-hidden p-0">
        <div className="flex h-full min-h-0 flex-col bg-[var(--cf-git-panel)]">
          <DialogHeader className="cf-git-header-surface shrink-0 border-b border-[var(--cf-git-panel-line)] px-5 py-4">
            <DialogTitle className="mb-1 text-base font-semibold">{props.title}</DialogTitle>
            <DialogDescription className="text-xs text-[var(--cf-text-secondary)]">
              {props.description}
            </DialogDescription>
          </DialogHeader>

          <div className="cf-git-toolbar-surface flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--cf-git-panel-line)] px-5 py-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="secondary">{gt("dialogs.multipleFileMerge.counters.unresolved", "{{count}} 个未解决", { count: snapshot?.unresolvedCount || 0 })}</Badge>
              {(snapshot?.resolvedCount || 0) > 0 ? <Badge variant="outline">{gt("dialogs.multipleFileMerge.counters.resolved", "{{count}} 个已解决", { count: snapshot?.resolvedCount || 0 })}</Badge> : null}
              {operationBadge ? <Badge variant="outline">{operationBadge}</Badge> : null}
            </div>
            <div className="text-[11px] text-[var(--cf-text-secondary)]">
              {buildMergeConflictScopeHint(snapshot, gt)}
            </div>
          </div>

          <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex min-h-0 min-w-0 flex-col border-b border-[var(--cf-git-panel-line)] lg:border-b-0 lg:border-r">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--cf-git-panel-line)] px-5 py-4">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[var(--cf-text-primary)]">{gt("dialogs.multipleFileMerge.title", "冲突文件")}</div>
                  <div className="mt-1 text-[11px] text-[var(--cf-text-secondary)]">
                    {selectionSummary}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={props.onRefresh}
                    disabled={props.submitting !== null || props.applyingSide !== null}
                  >
                    <RefreshCcw className="mr-1 h-3.5 w-3.5" />
                    {gt("dialogs.multipleFileMerge.toolbar.refresh", "刷新")}
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={props.onSelectNext}
                    disabled={(snapshot?.unresolvedCount || 0) <= 1 || props.submitting !== null || props.applyingSide !== null}
                    data-testid="conflict-resolver-next"
                  >
                    <SkipForward className="mr-1 h-3.5 w-3.5" />
                    {gt("dialogs.multipleFileMerge.toolbar.nextUnresolved", "下一个未解决")}
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={(snapshot?.unresolvedCount || 0) <= 0 || props.submitting !== null || props.applyingSide !== null}
                    onClick={() => props.onToggleAll(!allChecked)}
                    data-testid="conflict-resolver-toggle-all"
                  >
                    {allChecked ? <Square className="mr-1 h-3.5 w-3.5" /> : <CheckSquare className="mr-1 h-3.5 w-3.5" />}
                    {allChecked ? gt("dialogs.multipleFileMerge.toolbar.clearSelection", "清空多选") : gt("dialogs.multipleFileMerge.toolbar.selectAllUnresolved", "全选未解决")}
                  </Button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto bg-[var(--cf-git-panel-elevated)]">
                <table className="w-full border-collapse text-xs">
                  <thead className="sticky top-0 z-10 bg-[var(--cf-git-panel-elevated)]">
                    <tr className="border-b border-[var(--cf-git-panel-line)] text-left text-[11px] text-[var(--cf-text-secondary)]">
                      <th className="w-10 px-3 py-2">{gt("dialogs.multipleFileMerge.headers.selected", "选中")}</th>
                      <th className="px-3 py-2">{gt("dialogs.multipleFileMerge.headers.file", "文件")}</th>
                      <th className="w-24 px-3 py-2">{snapshot?.labels.ours || gt("dialogs.multipleFileMerge.headers.ours", "你的更改")}</th>
                      <th className="w-24 px-3 py-2">{snapshot?.labels.theirs || gt("dialogs.multipleFileMerge.headers.theirs", "他们的更改")}</th>
                      <th className="w-[220px] px-3 py-2">{gt("dialogs.multipleFileMerge.headers.status", "状态")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.length <= 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-6 text-center text-[var(--cf-text-secondary)]">
                          {props.loading
                            ? gt("dialogs.multipleFileMerge.loading", "正在读取冲突表…")
                            : gt("dialogs.multipleFileMerge.empty", "当前没有需要显示的冲突文件。")}
                        </td>
                      </tr>
                    ) : tableRows.map((row) => {
                      if (row.kind === "section") {
                        return (
                          <tr key={row.key} className="border-b border-[var(--cf-git-panel-line)] bg-[var(--cf-git-panel-muted)]/80">
                            <td colSpan={5} className="px-3 py-2 text-[11px] font-medium text-[var(--cf-text-secondary)]">
                              {row.label} · {gt("dialogs.multipleFileMerge.sectionCount", "{{count}} 个文件", { count: row.count })}
                            </td>
                          </tr>
                        );
                      }
                      const entry = row.entry;
                      const node = row.node;
                      if (!node.isFile || !entry) {
                        const expanded = treeExpanded[node.key] !== false;
                        return (
                          <tr
                            key={row.key}
                            className="border-b border-[var(--cf-git-panel-line)] bg-[var(--cf-git-panel-muted)]/36 hover:bg-[var(--cf-git-row-hover)]"
                          >
                            <td className="px-3 py-2 text-[10px] text-[var(--cf-text-secondary)]">-</td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                className="flex min-w-0 items-center gap-2 text-left"
                                style={{ paddingLeft: `${row.depth * 18}px` }}
                                data-testid={`conflict-resolver-directory-${node.key}`}
                                onClick={() => toggleDirectoryNodeExpanded(node.key)}
                              >
                                <span className="inline-flex h-4 w-4 items-center justify-center rounded-apple-sm hover:bg-[var(--cf-surface-hover)]">
                                  {expanded ? <ChevronDown className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" /> : <ChevronRight className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />}
                                </span>
                                <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--cf-text-secondary)]" />
                                <span className="truncate text-sm font-medium text-[var(--cf-text-primary)]">{node.name}</span>
                              </button>
                            </td>
                            <td className="px-3 py-2 text-[var(--cf-text-secondary)]">-</td>
                            <td className="px-3 py-2 text-[var(--cf-text-secondary)]">-</td>
                            <td className="px-3 py-2 text-[var(--cf-text-secondary)]">
                              {formatMergeConflictDirectorySummary(
                                node.filePaths.filter((pathText) => (
                                  row.sectionKey === "unresolved"
                                    ? unresolvedPathSet.has(pathText)
                                    : true
                                )).length || node.fileCount || node.count,
                                gt,
                              )}
                            </td>
                          </tr>
                        );
                      }
                      const selected = entry.path === props.selectedPath;
                      const checked = checkedPathSet.has(entry.path);
                      const badges = buildMergeSessionBadges(entry, gt);
                      const rowPrimaryAction = resolveMergeConflictPrimaryAction(entry);
                      return (
                        <tr
                          key={row.key}
                          className={cn(
                            "border-b border-[var(--cf-git-panel-line)] align-top transition-colors",
                            selected
                              ? "cf-git-row-selected-surface"
                              : "bg-transparent hover:bg-[var(--cf-git-row-hover)]",
                          )}
                        >
                          <td className="px-3 py-2">
                            {entry.conflictState === "unresolved" ? (
                              <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4"
                                checked={checked}
                                disabled={props.submitting !== null || props.applyingSide !== null}
                                onChange={(event) => props.onTogglePath(entry.path, event.target.checked)}
                              />
                            ) : (
                              <span className="text-[10px] text-[var(--cf-text-secondary)]">-</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              className="min-w-0 text-left"
                              data-testid={`conflict-resolver-row-${entry.path}`}
                              onClick={() => props.onSelectPath(entry.path)}
                              onDoubleClick={() => {
                                props.onSelectPath(entry.path);
                                if (selected && rowPrimaryAction.enabled) props.onOpenSelected();
                              }}
                            >
                              <div className="flex items-center gap-2" style={{ paddingLeft: `${row.depth * 18}px` }}>
                                {props.groupByDirectory ? <span className="inline-block h-4 w-4 shrink-0" /> : null}
                                <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[var(--cf-accent)]" />
                                <div className="truncate text-sm font-medium text-[var(--cf-text-primary)]">{entry.fileName}</div>
                              </div>
                              <div className="mt-1 break-all pl-[1.35rem] text-[11px] text-[var(--cf-text-secondary)]">
                                {props.groupByDirectory ? entry.directoryPath || entry.path : entry.path}
                              </div>
                            </button>
                          </td>
                          <td className="px-3 py-2 text-[var(--cf-text-secondary)]">{formatMergeConflictSideState(entry.oursState, gt)}</td>
                          <td className="px-3 py-2 text-[var(--cf-text-secondary)]">{formatMergeConflictSideState(entry.theirsState, gt)}</td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              {badges.slice(0, 3).map((badge) => (
                                <Badge key={`${entry.path}:${badge}`} variant={badge === gt("dialogs.multipleFileMerge.badges.resolved", "已解决") ? "secondary" : "outline"} className="text-[10px]">
                                  {badge}
                                </Badge>
                              ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex min-h-0 min-w-0 flex-col bg-[var(--cf-git-panel-muted)]/45">
              <div className="shrink-0 border-b border-[var(--cf-git-panel-line)] px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span className="text-sm font-semibold">{selectedEntry ? gt("dialogs.multipleFileMerge.sidebar.selectedFile", "当前选中文件") : gt("dialogs.multipleFileMerge.sidebar.conflictState", "冲突状态")}</span>
                  {selectedEntry?.conflictState === "resolved" ? <Badge variant="outline">{gt("dialogs.multipleFileMerge.badges.resolved", "已解决")}</Badge> : null}
                  {selectedEntry?.reverseSides ? <Badge variant="outline">{gt("dialogs.multipleFileMerge.badges.reverseSides", "已反转冲突侧")}</Badge> : null}
                </div>
                {selectedEntry ? (
                  <>
                    <div className="mt-3 flex items-start gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)]">
                        {props.groupByDirectory ? <Folder className="h-4 w-4 text-[var(--cf-text-secondary)]" /> : <FileCode2 className="h-4 w-4 text-[var(--cf-accent)]" />}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-[var(--cf-text-primary)]">{selectedEntry.fileName}</div>
                        <div className="mt-1 break-all text-[11px] text-[var(--cf-text-secondary)]">{selectedEntry.path}</div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1">
                      {buildMergeSessionBadges(selectedEntry, gt).map((badge) => (
                        <Badge key={`sidebar:${selectedEntry.path}:${badge}`} variant={badge === gt("dialogs.multipleFileMerge.badges.resolved", "已解决") ? "secondary" : "outline"} className="text-[10px]">
                          {badge}
                        </Badge>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
              <div className="shrink-0 space-y-2 border-b border-[var(--cf-git-panel-line)] px-4 py-4">
                <Button
                  size="sm"
                  className="w-full justify-center"
                  variant="secondary"
                  onClick={() => props.onApplySide("ours")}
                  disabled={!canApplySide}
                  data-testid="conflict-resolver-accept-ours"
                >
                  {props.applyingSide === "ours" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  {buildAcceptConflictSideActionLabel(snapshot?.labels.ours || "", gt)}
                </Button>
                <Button
                  size="sm"
                  className="w-full justify-center"
                  variant="secondary"
                  onClick={() => props.onApplySide("theirs")}
                  disabled={!canApplySide}
                  data-testid="conflict-resolver-accept-theirs"
                >
                  {props.applyingSide === "theirs" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  {buildAcceptConflictSideActionLabel(snapshot?.labels.theirs || "", gt)}
                </Button>
                <Button
                  size="sm"
                  className="w-full justify-center"
                  data-cf-dialog-primary="true"
                  onClick={props.onOpenSelected}
                  disabled={!primaryAction.enabled || props.submitting !== null || props.applyingSide !== null}
                  data-testid="conflict-resolver-open-selected"
                >
                  {props.loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  {primaryAction.label}
                </Button>
                {props.onOpenSelectedInIde ? (
                  <Button
                    size="sm"
                    className="w-full justify-center"
                    variant="secondary"
                    onClick={props.onOpenSelectedInIde}
                    disabled={!canOpenFallback}
                    data-testid="conflict-resolver-open-in-ide"
                  >
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                    {gt("dialogs.multipleFileMerge.buttons.openInIde", "在外部 IDE 中打开")}
                  </Button>
                ) : null}
                {props.onOpenSelectedInSystem ? (
                  <Button
                    size="sm"
                    className="w-full justify-center"
                    variant="secondary"
                    onClick={props.onOpenSelectedInSystem}
                    disabled={!canOpenFallback}
                    data-testid="conflict-resolver-open-in-system"
                  >
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                    {gt("dialogs.multipleFileMerge.buttons.openInSystem", "使用系统程序打开")}
                  </Button>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-4 text-xs text-[var(--cf-text-secondary)]">
                {selectedEntry ? (
                  <>
                    <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-3">
                      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--cf-text-muted)]">{gt("dialogs.multipleFileMerge.blocks.primaryAction", "主操作")}</div>
                      <div className="mt-2 text-sm leading-5 text-[var(--cf-text-primary)]">
                        {primaryActionDescription}
                      </div>
                    </div>
                    <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-3 leading-5">
                      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--cf-text-muted)]">{gt("dialogs.multipleFileMerge.blocks.sourceSnapshot", "来源快照")}</div>
                      <div className="mt-3 space-y-2">
                        <div>{getMergeSessionRevisionStateText(selectedEntry.base.label, selectedEntry.base, gt)}</div>
                        <div>{getMergeSessionRevisionStateText(selectedEntry.ours.label, selectedEntry.ours, gt)}</div>
                        <div>{getMergeSessionRevisionStateText(selectedEntry.theirs.label, selectedEntry.theirs, gt)}</div>
                        <div>{getMergeSessionRevisionStateText(selectedEntry.working.label, selectedEntry.working, gt)}</div>
                      </div>
                      <div className="mt-3">
                        {selectedEntry.conflictState === "resolved"
                          ? gt("dialogs.multipleFileMerge.details.resolvedFile", "该文件已从未解决列表移除，但仍保留在统一状态源中，可继续打开查看当前结果。")
                          : selectedEntry.canOpenMerge
                            ? gt("dialogs.multipleFileMerge.details.canOpenMerge", "当前文件支持继续进入应用内合并。")
                            : gt("dialogs.multipleFileMerge.details.cannotOpenMerge", "当前文件不支持应用内合并，建议直接交给外部 IDE 或系统默认程序处理。")}
                      </div>
                    </div>
                    {effectivePaths.length > 1 ? (
                      <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-3 leading-5">
                        {gt("dialogs.multipleFileMerge.details.batchApplied", "已勾选 {{count}} 个未解决文件；“接受某一侧更改”会批量写回并自动执行 `git add`。", { count: effectivePaths.length })}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-3 leading-5">
                    {gt("dialogs.multipleFileMerge.details.noSelectionHint", "当前没有选中文件。若所有 unresolved 都已清空，dialog 会自动收起；resolved 文件仍会由提交面板与状态条共享同一状态源。")}
                  </div>
                )}
                {props.operationState && props.operationState !== "normal" ? (
                  <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-yellow-light)]/80 px-3 py-3 leading-5 text-[var(--cf-warning-foreground)]">
                    {gt("dialogs.multipleFileMerge.details.operationInProgress", "当前仓库仍处于 {{badge}} 进行中状态。关闭后，顶部状态条仍会保留继续 / 中止入口。", { badge: operationBadge })}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="cf-git-toolbar-surface flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--cf-git-panel-line)] px-5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-1.5 text-[11px] text-[var(--cf-text-secondary)]">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={props.groupByDirectory}
                  disabled={props.submitting !== null || props.applyingSide !== null}
                  onChange={() => props.onToggleGroupByDirectory()}
                  data-testid="multiple-file-merge-group-by-directory"
                />
                {gt("dialogs.multipleFileMerge.footer.groupByDirectory", "按目录对文件分组")}
              </label>
              {(snapshot?.resolvedCount || 0) > 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={props.onToggleShowResolved}
                  disabled={props.submitting !== null || props.applyingSide !== null}
                  data-testid="multiple-file-merge-toggle-resolved"
                >
                  {props.showResolved ? gt("dialogs.multipleFileMerge.footer.hideResolved", "隐藏已解决") : gt("dialogs.multipleFileMerge.footer.showResolved", "显示已解决")}
                </Button>
              ) : null}
              {props.onShowInCommitPanel ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={props.onShowInCommitPanel}
                  disabled={props.submitting !== null || props.applyingSide !== null}
                >
                  {gt("dialogs.multipleFileMerge.footer.locateInCommitPanel", "在提交面板中定位")}
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {props.onContinue ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={props.onContinue}
                  disabled={!canContinue}
                  data-testid="conflict-resolver-continue"
                >
                  {props.submitting === "continue" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                  {props.continueLabel || gt("dialogs.multipleFileMerge.footer.continueCurrentOperation", "继续当前操作")}
                </Button>
              ) : null}
              {props.onAbort ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={props.onAbort}
                  disabled={!canAbort}
                  data-testid="conflict-resolver-abort"
                >
                  {props.submitting === "abort" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <X className="mr-1.5 h-3.5 w-3.5" />}
                  {gt("dialogs.multipleFileMerge.footer.abortCurrentOperation", "中止当前操作")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                data-cf-dialog-cancel="true"
                onClick={() => props.onOpenChange(false)}
                disabled={props.submitting !== null || props.applyingSide !== null}
              >
                {gt("dialogs.multipleFileMerge.footer.close", "关闭")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
