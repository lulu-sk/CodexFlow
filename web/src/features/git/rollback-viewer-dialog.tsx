// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { resolveGitTextWith } from "./git-i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ContextMenu, ContextMenuItem, renderContextMenuSections, type GitContextMenuState } from "./context-menu";
import {
  buildRollbackBrowserActionGroups,
  buildRollbackBrowserRows,
  formatRollbackBrowserDirectorySummary,
  normalizeRollbackBrowserGroupingKeys,
  resolveRollbackEntryFileName,
  type GitRollbackBrowserActionKey,
  type GitRollbackBrowserEntry,
  type GitRollbackBrowserGroupingKey,
} from "./rollback-browser-model";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  FileCode2,
  Folder,
  Loader2,
  RefreshCcw,
  SplitSquareHorizontal,
} from "lucide-react";

type RollbackViewerDialogProps = {
  open: boolean;
  title: string;
  description: string;
  entries: GitRollbackBrowserEntry[];
  selectedPaths: string[];
  activePath?: string;
  groupingKeys?: GitRollbackBrowserGroupingKey[];
  submitting: boolean;
  refreshing?: boolean;
  continueLabel?: string;
  onClose(): void;
  onSelectionChange(nextPaths: string[]): void;
  onGroupingKeysChange?(nextKeys: GitRollbackBrowserGroupingKey[]): void;
  onActivePathChange?(nextPath: string): void;
  onOpenDiff?(entry: GitRollbackBrowserEntry): void;
  onRefresh?(): void;
  onRollback(): void;
  onRollbackAndContinue?(): void;
};

type RollbackViewerMenuState = GitContextMenuState & {
  targetPath: string;
};

type GitTranslate = (key: string, fallback: string, values?: Record<string, unknown>) => string;

/**
 * 渲染可直接回滚的本地更改 browser，统一承接 blocked-changes、smart operation 与手动回滚入口。
 */
export function RollbackViewerDialog(props: RollbackViewerDialogProps): JSX.Element | null {
  const { t } = useTranslation(["git", "common"]);
  const gt: GitTranslate = (key, fallback, values) => {
    return resolveGitTextWith(t, key, fallback, values);
  };
  const {
    open,
    title,
    description,
    entries,
    selectedPaths,
    activePath,
    groupingKeys = [],
    submitting,
    refreshing = false,
    continueLabel,
    onClose,
    onSelectionChange,
    onGroupingKeysChange,
    onActivePathChange,
    onOpenDiff,
    onRefresh,
    onRollback,
    onRollbackAndContinue,
  } = props;
  const [menu, setMenu] = useState<RollbackViewerMenuState | null>(null);
  const [expandedDirectoryKeys, setExpandedDirectoryKeys] = useState<Record<string, boolean>>({});
  if (!open) return null;
  const normalizedSelected = useMemo(() => new Set(
    selectedPaths.map((path) => String(path || "").trim()).filter(Boolean),
  ), [selectedPaths]);
  const normalizedGroupingKeys = useMemo(
    () => normalizeRollbackBrowserGroupingKeys(groupingKeys),
    [groupingKeys],
  );
  const allPaths = useMemo(
    () => entries.map((entry) => String(entry.path || "").trim()).filter(Boolean),
    [entries],
  );
  const directoryGroupingEnabled = normalizedGroupingKeys.includes("directory");
  const rows = useMemo(
    () => buildRollbackBrowserRows(entries, normalizedGroupingKeys, expandedDirectoryKeys, gt),
    [entries, expandedDirectoryKeys, gt, normalizedGroupingKeys],
  );
  const activeEntry = useMemo(() => {
    const normalizedActivePath = String(activePath || "").trim();
    if (normalizedActivePath) {
      const matched = entries.find((entry) => entry.path === normalizedActivePath);
      if (matched) return matched;
    }
    for (const selectedPath of normalizedSelected) {
      const matched = entries.find((entry) => entry.path === selectedPath);
      if (matched) return matched;
    }
    return entries[0] || null;
  }, [activePath, entries, normalizedSelected]);
  const allSelected = allPaths.length > 0 && allPaths.every((path) => normalizedSelected.has(path));
  const selectedCount = allPaths.filter((path) => normalizedSelected.has(path)).length;
  const actionGroups = useMemo(() => buildRollbackBrowserActionGroups({
    hasEntries: entries.length > 0,
    hasSelection: selectedCount > 0,
    hasActiveEntry: !!activeEntry,
    translate: gt,
  }), [activeEntry, entries.length, gt, selectedCount]);

  const closeMenu = (): void => {
    setMenu(null);
  };

  /**
   * 切换 rollback viewer 的目录分组开关；由外层持久化控制，确保跨次打开沿用同一设置。
   */
  const toggleDirectoryGrouping = (): void => {
    onGroupingKeysChange?.(directoryGroupingEnabled ? [] : ["directory"]);
  };

  /**
   * 切换目录节点展开态；未显式记录的目录默认视为展开，对齐提交树默认展开语义。
   */
  const toggleDirectoryExpanded = (directoryKey: string): void => {
    setExpandedDirectoryKeys((prev) => ({
      ...prev,
      [directoryKey]: prev[directoryKey] === false,
    }));
  };

  /**
   * 按目录节点聚合的文件集合一次性切换勾选状态，保证目录分组与文件级选择共享同一数据源。
   */
  const toggleDirectorySelection = (filePaths: string[], nextChecked: boolean): void => {
    const next = new Set(normalizedSelected);
    for (const filePath of filePaths) {
      if (nextChecked) next.add(filePath);
      else next.delete(filePath);
    }
    onSelectionChange(Array.from(next));
  };

  /**
   * 集中处理 rollback browser 的 toolbar / popup 动作，避免多入口散落同一套分支逻辑。
   */
  const runBrowserAction = (actionId: GitRollbackBrowserActionKey): void => {
    if (actionId === "showDiff") {
      if (activeEntry && onOpenDiff) onOpenDiff(activeEntry);
      closeMenu();
      return;
    }
    if (actionId === "refresh") {
      onRefresh?.();
      closeMenu();
      return;
    }
    if (actionId === "selectAll") {
      onSelectionChange(allPaths);
      closeMenu();
      return;
    }
    if (actionId === "clearSelection") {
      onSelectionChange([]);
      closeMenu();
      return;
    }
    if (actionId === "selectOnly") {
      if (activeEntry) onSelectionChange([activeEntry.path]);
      closeMenu();
      return;
    }
    if (actionId === "copyPath") {
      const targetPath = String(activeEntry?.path || "").trim();
      if (targetPath) void window.host?.utils?.copyText?.(targetPath);
      closeMenu();
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !submitting) onClose();
        }}
      >
        <DialogContent className="cf-git-dialog-panel flex max-h-[calc(100vh-3rem)] w-[1080px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden p-0">
          <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
            <DialogTitle className="text-base">{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
            <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)]">
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-2">
                <div className="flex items-center gap-2 text-[10px] font-apple-medium uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
                  <Folder className="h-3.5 w-3.5" />
                  <span>{gt("dialogs.rollbackViewer.files.title", "待回滚文件")}</span>
                  <span className="text-[11px] font-normal normal-case tracking-normal text-[var(--cf-text-secondary)]">
                    {gt("dialogs.rollbackViewer.files.selectedCount", "已选 {{selected}} / {{total}}", {
                      selected: selectedCount,
                      total: allPaths.length,
                    })}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={submitting || refreshing}
                    title={gt("dialogs.rollbackViewer.toolbar.refresh", "刷新")}
                    onClick={() => {
                      runBrowserAction("refresh");
                    }}
                  >
                    {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={submitting || !activeEntry || !onOpenDiff}
                    title={gt("dialogs.rollbackViewer.toolbar.showDiff", "显示差异")}
                    onClick={() => {
                      runBrowserAction("showDiff");
                    }}
                  >
                    <SplitSquareHorizontal className="h-3.5 w-3.5" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger>
                      <Button size="icon-sm" variant="ghost" title={gt("dialogs.rollbackViewer.toolbar.viewOptions", "视图选项")}>
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[180px]">
                      <DropdownMenuLabel>{gt("dialogs.rollbackViewer.viewMenu.groupBy", "分组依据")}</DropdownMenuLabel>
                      <DropdownMenuItem onClick={toggleDirectoryGrouping}>
                        <Check className={`mr-2 h-3.5 w-3.5 ${directoryGroupingEnabled ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                        {gt("dialogs.rollbackViewer.viewMenu.directory", "目录")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={submitting || allPaths.length <= 0}
                    onClick={() => {
                      runBrowserAction(allSelected ? "clearSelection" : "selectAll");
                    }}
                  >
                    {allSelected
                      ? gt("dialogs.rollbackViewer.actions.clearSelection", "取消全选")
                      : gt("dialogs.rollbackViewer.actions.selectAll", "全选")}
                  </Button>
                  <Button size="xs" disabled={submitting || selectedCount <= 0} onClick={onRollback}>
                    {submitting ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>{gt("dialogs.rollbackViewer.actions.submitting", "回滚中...")}</span>
                      </>
                    ) : gt("dialogs.rollbackViewer.actions.rollback", "回滚所选更改")}
                  </Button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto bg-[var(--cf-surface-solid)]">
                {rows.length > 0 ? (
                  <div className="divide-y divide-[var(--cf-border)]">
                    {rows.map((row) => {
                      if (row.kind === "directory") {
                        const selectedPathCount = row.filePaths.filter((path) => normalizedSelected.has(path)).length;
                        const checked = row.filePaths.length > 0 && selectedPathCount === row.filePaths.length;
                        const indeterminate = selectedPathCount > 0 && selectedPathCount < row.filePaths.length;
                        return (
                          <div
                            key={row.key}
                            className={cn(
                              "cf-git-list-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 px-2 py-1.5 text-xs",
                              checked || indeterminate ? "cf-git-row-selected" : "",
                            )}
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[var(--cf-accent)]"
                              checked={checked}
                              disabled={submitting || row.filePaths.length <= 0}
                              ref={(node) => {
                                if (node) node.indeterminate = indeterminate;
                              }}
                              onChange={() => {
                                toggleDirectorySelection(row.filePaths, !checked);
                              }}
                              onClick={(event) => {
                                event.stopPropagation();
                              }}
                            />
                            <button
                              type="button"
                              className="flex min-w-0 items-center gap-2 text-left"
                              style={{ paddingLeft: `${row.depth * 18}px` }}
                              onClick={() => {
                                toggleDirectoryExpanded(row.key);
                              }}
                              title={row.label}
                            >
                              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-apple-sm hover:bg-[var(--cf-surface-hover)]">
                                {row.expanded ? (
                                  <ChevronDown className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                                )}
                              </span>
                              <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--cf-text-secondary)]" />
                              <span className="truncate text-[var(--cf-text-primary)]">{row.label}</span>
                            </button>
                            <span className="truncate text-[11px] text-[var(--cf-text-secondary)]">
                              {formatRollbackBrowserDirectorySummary(row, gt)}
                            </span>
                          </div>
                        );
                      }

                      const entry = row.entry;
                      const checked = normalizedSelected.has(entry.path);
                      const selected = activeEntry?.path === entry.path;
                      return (
                        <div
                          key={row.key}
                          className={cn(
                            "cf-git-list-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 py-1.5 text-xs",
                            checked || selected ? "cf-git-row-selected" : "",
                          )}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onActivePathChange?.(entry.path);
                            setMenu({
                              x: event.clientX,
                              y: event.clientY,
                              targetPath: entry.path,
                            });
                          }}
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[var(--cf-accent)]"
                            checked={checked}
                            disabled={submitting}
                            onChange={() => {
                              const next = new Set(normalizedSelected);
                              if (checked) next.delete(entry.path);
                              else next.add(entry.path);
                              onSelectionChange(Array.from(next));
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                            }}
                          />
                          <button
                            type="button"
                            className="flex min-w-0 items-center gap-2 text-left"
                            style={{ paddingLeft: `${row.depth * 18}px` }}
                            onClick={() => {
                              onActivePathChange?.(entry.path);
                            }}
                            onDoubleClick={() => {
                              onActivePathChange?.(entry.path);
                              if (onOpenDiff) onOpenDiff(entry);
                            }}
                            title={entry.path}
                          >
                            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[var(--cf-accent)] opacity-90" />
                            <div className="min-w-0 flex flex-1 items-baseline gap-2 overflow-hidden">
                              <span className="truncate text-[var(--cf-text-primary)]">
                                {resolveRollbackEntryFileName(entry)}
                              </span>
                              {entry.directory !== gt("dialogs.rollbackViewer.labels.repositoryRoot", "仓库根") ? (
                                <span className="truncate text-[11px] text-[var(--cf-text-secondary)]">
                                  {entry.directory}
                                </span>
                              ) : null}
                              {entry.oldPath ? (
                                <span className="truncate text-[11px] text-[var(--cf-text-secondary)]">
                                  {gt("dialogs.rollbackViewer.labels.fromPath", "来自 {{path}}", { path: entry.oldPath })}
                                </span>
                              ) : null}
                            </div>
                          </button>
                          {entry.groupKey !== "modified" ? (
                            <span className="truncate text-[10px] text-[var(--cf-text-secondary)]">
                              {entry.groupLabel}
                            </span>
                          ) : (
                            <span className="w-0" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="px-4 py-6 text-sm text-[var(--cf-text-secondary)]">
                    {gt("dialogs.rollbackViewer.empty", "当前没有可展示的本地更改。")}
                  </div>
                )}
              </div>
            </section>
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--cf-border)] px-5 py-4">
            <div className="text-[11px] text-[var(--cf-text-secondary)]">
              {gt("dialogs.rollbackViewer.summary", "已选 {{selected}} / {{total}}。回滚只会处理当前勾选的文件，并保持其余本地更改不受影响。", {
                selected: selectedCount,
                total: allPaths.length,
              })}
            </div>
            <div className="flex items-center gap-2">
              <Button size="xs" variant="secondary" disabled={submitting} onClick={onClose}>
                {gt("dialogs.rollbackViewer.actions.close", "关闭")}
              </Button>
              {onRollbackAndContinue ? (
                <Button size="xs" disabled={submitting || selectedCount <= 0} onClick={onRollbackAndContinue}>
                  {continueLabel || gt("dialogs.rollbackViewer.actions.rollbackAndContinue", "回滚并继续")}
                </Button>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ContextMenu menu={menu} onClose={closeMenu} actionGroupId="git.rollback.browser.popup">
        {renderContextMenuSections(actionGroups.map((group) => group.items.map((action) => (
          <ContextMenuItem
            key={`${group.id}:${action.id}`}
            label={action.label}
            shortcut={action.shortcut}
            disabled={action.enabled === false}
            title={action.reason}
            tone={action.tone}
            onClick={() => {
              runBrowserAction(action.id);
            }}
          />
        ))))}
      </ContextMenu>
    </>
  );
}
