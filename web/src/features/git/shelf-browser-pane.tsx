// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  buildShelfBrowserRows,
  formatShelfBrowserDirectorySummary,
  type GitShelfBrowserRow,
} from "./shelf-browser-model";
import type { GitShelfItem, GitShelfViewState, GitStashItem } from "./types";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  Eye,
  FileCode2,
  Folder,
  Loader2,
  RefreshCcw,
  Upload,
  X,
} from "lucide-react";

type GitTranslate = (key: string, fallback: string, values?: Record<string, unknown>) => string;

type ShelfBrowserPaneProps = {
  items: GitShelfItem[];
  stashItems: GitStashItem[];
  viewState: GitShelfViewState;
  refreshing?: boolean;
  onRefresh(): void;
  onImportPatch(): void;
  onViewStateChange(patch: Partial<GitShelfViewState>): void;
  onOpenShelfRestore(shelf: GitShelfItem, selectedPaths?: string[]): void;
  onRenameShelf(shelf: GitShelfItem): void;
  onRecycleShelf(shelf: GitShelfItem): void;
  onRestoreArchivedShelf(shelf: GitShelfItem): void;
  onDeleteShelfPermanently(shelf: GitShelfItem): void;
  onRunDiffAction?(
    shelf: GitShelfItem,
    selectedPaths: string[],
    action: "showDiff" | "showStandaloneDiff" | "compareWithLocal",
  ): void;
  onCreatePatch?(shelf: GitShelfItem, selectedPaths: string[], mode: "save" | "clipboard"): void;
  onStashAction?(stash: GitStashItem, action: "apply" | "pop" | "branch" | "drop"): void;
};

type ShelfBrowserMenuState = GitContextMenuState & {
  rowKey: string;
};

/**
 * 规整 shelf 中携带的路径集合，供局部取消搁置时稳定透传到恢复对话框。
 */
function normalizeShelfSelectionPaths(paths: string[] | undefined): string[] {
  return Array.from(new Set(
    (Array.isArray(paths) ? paths : [])
      .map((item) => String(item || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  ));
}

/**
 * 把当前 shelf 树节点映射成菜单动作需要的路径集合；目录节点返回整组路径，shelf 节点返回整条记录路径。
 */
function resolveShelfRowSelectionPaths(row: GitShelfBrowserRow | null | undefined): string[] {
  if (!row) return [];
  if (row.kind === "file") return normalizeShelfSelectionPaths([row.path]);
  if (row.kind === "directory") return normalizeShelfSelectionPaths(row.filePaths);
  if (row.kind === "shelf") return normalizeShelfSelectionPaths(row.shelf.paths);
  return [];
}

/**
 * 格式化 shelf 时间文本；与工作台内其他时间显示保持同一套本地化语义。
 */
function formatShelfDateText(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * 判断当前 shelf 是否属于已归档列表；归档项在 UI 上应切换为“恢复列表/彻底删除”语义。
 */
function isArchivedShelfItem(shelf: GitShelfItem): boolean {
  return shelf.state === "recycled" || shelf.state === "deleted";
}

/**
 * 判断当前 browser 行是否支持展开/收起；目录、shelf 与标签节点共用这一套判定。
 */
function isExpandableShelfRow(row: GitShelfBrowserRow): boolean {
  if (row.kind === "directory") return row.fileCount > 0;
  if (row.kind === "shelf") return row.fileCount > 0;
  if (row.kind === "tag") return row.itemCount > 0;
  return false;
}

/**
 * 把 browser 行映射回所属 shelf；标签节点本身不绑定具体记录。
 */
function resolveShelfRowOwner(row: GitShelfBrowserRow | null | undefined): GitShelfItem | null {
  if (!row || row.kind === "tag") return null;
  return row.shelf;
}

/**
 * 生成当前行主动作文案，保持工具栏、双击与右键菜单使用同一套语义。
 */
export function resolveShelfPrimaryActionLabel(row: GitShelfBrowserRow | null | undefined, gt?: GitTranslate): string {
  const shelf = resolveShelfRowOwner(row);
  if (!shelf) return "";
  if (isArchivedShelfItem(shelf)) return gt ? gt("shelf.primary.restore", "恢复搁置记录") : "恢复搁置记录";
  if (row?.kind === "file") return gt ? gt("shelf.primary.restoreSelectedFile", "取消搁置所选文件...") : "取消搁置所选文件...";
  if (row?.kind === "directory") return gt ? gt("shelf.primary.restoreSelectedPath", "取消搁置所选路径...") : "取消搁置所选路径...";
  return gt ? gt("shelf.primary.restoreShelf", "取消搁置...") : "取消搁置...";
}

/**
 * 生成当前行删除动作文案；活动 shelf 先回收，归档 shelf 才允许永久删除。
 */
export function resolveShelfDeleteActionLabel(row: GitShelfBrowserRow | null | undefined, gt?: GitTranslate): string {
  const shelf = resolveShelfRowOwner(row);
  if (!shelf) return "";
  return gt ? gt("shelf.deleteAction", "删除...") : "删除...";
}

/**
 * 为非正常 shelf 状态输出简短标识，避免树节点标题被冗长状态文本干扰。
 */
function resolveShelfStateBadgeLabel(state: GitShelfItem["state"], gt?: GitTranslate): string {
  if (state === "recycled") return gt ? gt("shelf.state.recycled", "已归档") : "已归档";
  if (state === "deleted") return gt ? gt("shelf.state.deleted", "已删除") : "已删除";
  if (state === "restoring") return gt ? gt("shelf.state.restoring", "取消搁置中") : "取消搁置中";
  if (state === "restore-failed") return gt ? gt("shelf.state.restoreFailed", "取消搁置失败") : "取消搁置失败";
  if (state === "restored") return gt ? gt("shelf.state.restored", "已取消搁置") : "已取消搁置";
  if (state === "orphaned") return gt ? gt("shelf.state.orphaned", "孤儿") : "孤儿";
  return "";
}

/**
 * 渲染 shelf 树浏览器，对齐 IDEA 的树形 shelf / recently deleted / directory grouping 交互。
 */
export function ShelfBrowserPane(props: ShelfBrowserPaneProps): JSX.Element {
  const { t } = useTranslation(["git", "common"]);
  const {
    items,
    stashItems,
    viewState,
    refreshing = false,
    onRefresh,
    onImportPatch,
    onViewStateChange,
    onOpenShelfRestore,
    onRenameShelf,
    onRecycleShelf,
    onRestoreArchivedShelf,
    onDeleteShelfPermanently,
    onRunDiffAction,
    onCreatePatch,
    onStashAction,
  } = props;
  const gt = React.useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveGitTextWith(t, key, fallback, values);
  }, [t]);
  const [activeRowKey, setActiveRowKey] = useState<string>("");
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<ShelfBrowserMenuState | null>(null);
  const groupingKeys = useMemo(
    () => (viewState.groupByDirectory ? ["directory"] as const : []),
    [viewState.groupByDirectory],
  );
  const rows = useMemo(
    () => buildShelfBrowserRows({
      items,
      showRecycled: viewState.showRecycled,
      groupingKeys,
      expanded: expandedRows,
      translate: gt,
    }),
    [expandedRows, groupingKeys, gt, items, viewState.showRecycled],
  );
  const fullyExpandedRows = useMemo(
    () => buildShelfBrowserRows({
      items,
      showRecycled: viewState.showRecycled,
      groupingKeys,
      expanded: {},
      translate: gt,
    }),
    [groupingKeys, gt, items, viewState.showRecycled],
  );
  const activeRow = useMemo(
    () => rows.find((row) => row.key === activeRowKey) || null,
    [activeRowKey, rows],
  );
  const menuRow = useMemo(
    () => rows.find((row) => row.key === menu?.rowKey) || null,
    [menu?.rowKey, rows],
  );
  const menuShelf = useMemo(
    () => resolveShelfRowOwner(menuRow),
    [menuRow],
  );
  const menuSelectionPaths = useMemo(
    () => resolveShelfRowSelectionPaths(menuRow),
    [menuRow],
  );
  const visibleShelfCount = useMemo(
    () => rows.filter((row) => row.kind === "shelf").length,
    [rows],
  );
  const expandableRowKeys = useMemo(
    () => fullyExpandedRows.filter((row) => isExpandableShelfRow(row)).map((row) => row.key),
    [fullyExpandedRows],
  );
  const activePrimaryActionLabel = resolveShelfPrimaryActionLabel(activeRow, gt);
  const activeDeleteActionLabel = resolveShelfDeleteActionLabel(activeRow, gt);

  useEffect(() => {
    if (rows.length <= 0) {
      if (activeRowKey) setActiveRowKey("");
      if (menu) setMenu(null);
      return;
    }
    if (rows.some((row) => row.key === activeRowKey)) return;
    setActiveRowKey(rows[0]!.key);
  }, [activeRowKey, menu, rows]);

  useEffect(() => {
    if (!menu) return;
    if (rows.some((row) => row.key === menu.rowKey)) return;
    setMenu(null);
  }, [menu, rows]);

  /**
   * 切换目录/shelf/tag 节点展开态；未显式记录的节点默认视为展开，对齐 IDEA 初始展开语义。
   */
  const toggleExpanded = (rowKey: string): void => {
    setExpandedRows((prev) => ({
      ...prev,
      [rowKey]: prev[rowKey] === false,
    }));
  };

  /**
   * 执行当前选中行的主动作；活动项进入取消搁置流程，归档项回到活动列表。
   */
  const runPrimaryAction = (row: GitShelfBrowserRow | null | undefined): void => {
    const targetRow = row || activeRow;
    const shelf = resolveShelfRowOwner(targetRow);
    if (!targetRow || !shelf) return;
    if (isArchivedShelfItem(shelf)) {
      onRestoreArchivedShelf(shelf);
      return;
    }
    onOpenShelfRestore(shelf, resolveShelfRowSelectionPaths(targetRow));
  };

  /**
   * 执行当前选中行的删除动作；活动 shelf 进入回收区，归档 shelf 则永久删除。
   */
  const runDeleteAction = (row: GitShelfBrowserRow | null | undefined): void => {
    const shelf = resolveShelfRowOwner(row || activeRow);
    if (!shelf) return;
    if (isArchivedShelfItem(shelf)) {
      onDeleteShelfPermanently(shelf);
      return;
    }
    onRecycleShelf(shelf);
  };

  /**
   * 执行当前选中行的重命名动作；目录/文件节点统一落到所属 shelf 记录。
   */
  const runRenameAction = (row: GitShelfBrowserRow | null | undefined): void => {
    const shelf = resolveShelfRowOwner(row || activeRow);
    if (!shelf) return;
    onRenameShelf(shelf);
  };

  /**
   * 执行 shelf 右键里的 Diff 动作；文件/目录/shelf 节点都会折叠成同一套路径组选区后交给工作台主链路。
   */
  const runDiffAction = (
    row: GitShelfBrowserRow | null | undefined,
    action: "showDiff" | "showStandaloneDiff" | "compareWithLocal",
  ): void => {
    const shelf = resolveShelfRowOwner(row || activeRow);
    const selectedPaths = resolveShelfRowSelectionPaths(row || activeRow);
    if (!shelf || selectedPaths.length <= 0) return;
    onRunDiffAction?.(shelf, selectedPaths, action);
  };

  /**
   * 执行 shelf 的 Create Patch / Copy Patch；路径组选区统一交给上层聚合导出，保持和 IDEA 菜单语义一致。
   */
  const runCreatePatchAction = (
    row: GitShelfBrowserRow | null | undefined,
    mode: "save" | "clipboard",
  ): void => {
    const shelf = resolveShelfRowOwner(row || activeRow);
    const selectedPaths = resolveShelfRowSelectionPaths(row || activeRow);
    if (!shelf || selectedPaths.length <= 0) return;
    onCreatePatch?.(shelf, selectedPaths, mode);
  };

  /**
   * 统一打开 shelf 右键菜单，并同步切换当前活动节点，保证菜单动作作用于可见选中项。
   */
  const openRowMenu = (event: React.MouseEvent, row: GitShelfBrowserRow): void => {
    event.preventDefault();
    event.stopPropagation();
    setActiveRowKey(row.key);
    setMenu({
      x: event.clientX,
      y: event.clientY,
      rowKey: row.key,
    });
  };

  /**
   * 切换是否显示回收区，对齐 IDEA 的 Show/Hide Recycled 独立开关。
   */
  const toggleShowRecycled = (): void => {
    onViewStateChange({ showRecycled: !viewState.showRecycled });
  };

  /**
   * 切换按目录分组开关，保持与 IDEA 分组菜单里的目录维度一致。
   */
  const toggleDirectoryGrouping = (): void => {
    onViewStateChange({ groupByDirectory: !viewState.groupByDirectory });
  };

  /**
   * 统一展开当前 browser 的所有可展开节点；使用“全展开”模型补齐已折叠分支下的子节点 key。
   */
  const expandAllRows = (): void => {
    setExpandedRows((prev) => {
      const next = { ...prev };
      for (const rowKey of expandableRowKeys) {
        next[rowKey] = true;
      }
      return next;
    });
  };

  /**
   * 统一收起当前 browser 的所有可展开节点；保持“最近删除”标签与目录树一起折叠。
   */
  const collapseAllRows = (): void => {
    setExpandedRows((prev) => {
      const next = { ...prev };
      for (const rowKey of expandableRowKeys) {
        next[rowKey] = false;
      }
      return next;
    });
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="cf-git-pane-header shrink-0 border-b border-[var(--cf-border)] px-2 py-1">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 text-[11px] font-apple-medium text-[var(--cf-text-secondary)]">
              {gt("shelf.title", "搁置记录")}
              <span className="ml-2 font-normal text-[var(--cf-text-secondary)]">
                {gt("shelf.visibleCount", "可见 {{count}} 条", { count: visibleShelfCount })}
              </span>
            </div>
            <div className="cf-git-toolbar-scroll no-scrollbar flex items-center gap-1 overflow-x-auto">
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!activePrimaryActionLabel}
                title={activePrimaryActionLabel || gt("shelf.messages.primaryUnavailable", "当前选择不可执行取消搁置")}
                onClick={() => {
                  runPrimaryAction(activeRow);
                }}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title={gt("shelf.importPatch", "导入补丁...")}
                onClick={onImportPatch}
              >
                <Upload className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title={viewState.showRecycled ? gt("shelf.toggleArchived.hide", "隐藏已归档项") : gt("shelf.toggleArchived.show", "显示已归档项")}
                onClick={toggleShowRecycled}
              >
                <Eye className={`h-3.5 w-3.5 ${viewState.showRecycled ? "text-[var(--cf-accent)]" : ""}`} />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title={gt("shelf.expandAll", "展开全部")}
                onClick={expandAllRows}
              >
                <ChevronsUpDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title={gt("shelf.collapseAll", "收起全部")}
                onClick={collapseAllRows}
              >
                <ChevronsDownUp className="h-3.5 w-3.5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger>
                  <Button size="icon-sm" variant="ghost" title={gt("shelf.viewOptions", "视图选项")}>
                    <Folder className={`h-3.5 w-3.5 ${viewState.groupByDirectory ? "text-[var(--cf-accent)]" : ""}`} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[180px]">
                  <DropdownMenuLabel>{gt("shelf.groupBy", "分组依据")}</DropdownMenuLabel>
                  <DropdownMenuItem onClick={toggleDirectoryGrouping}>
                    <Check className={`mr-2 h-3.5 w-3.5 ${viewState.groupByDirectory ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                    {gt("shelf.groupByDirectory", "目录")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!activeDeleteActionLabel}
                title={activeDeleteActionLabel || gt("shelf.messages.deleteUnavailable", "当前选择不可删除")}
                onClick={() => {
                  runDeleteAction(activeRow);
                }}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title={gt("shelf.refresh", "刷新")}
                onClick={onRefresh}
              >
                {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-[var(--cf-surface-solid)] cf-scroll-area">
          {rows.length > 0 ? (
            <div className="divide-y divide-[var(--cf-border)]">
              {rows.map((row) => {
                const selected = row.key === activeRowKey;
                const shelf = resolveShelfRowOwner(row);
                const archived = !!shelf && isArchivedShelfItem(shelf);
                const stateLabel = shelf ? resolveShelfStateBadgeLabel(shelf.state, gt) : "";
                if (row.kind === "tag") {
                  return (
                    <div
                      key={row.key}
                      className={cn(
                        "cf-git-list-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 py-1.5 text-xs",
                        selected ? "cf-git-row-selected" : "",
                      )}
                      onContextMenu={(event) => {
                        openRowMenu(event, row);
                      }}
                    >
                      <button
                        type="button"
                        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-apple-sm hover:bg-[var(--cf-surface-hover)]"
                        onClick={() => {
                          toggleExpanded(row.key);
                        }}
                      >
                        {row.expanded ? (
                          <ChevronDown className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="min-w-0 text-left"
                        onClick={() => {
                          setActiveRowKey(row.key);
                        }}
                        onDoubleClick={() => {
                          toggleExpanded(row.key);
                        }}
                      >
                        <div className="truncate text-[11px] font-apple-medium uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
                          {row.label}
                        </div>
                      </button>
                      <span className="text-[11px] text-[var(--cf-text-secondary)]">{row.itemCount}</span>
                    </div>
                  );
                }

                if (row.kind === "directory") {
                  return (
                    <div
                      key={row.key}
                      className={cn(
                        "cf-git-list-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 py-1.5 text-xs",
                        selected ? "cf-git-row-selected" : "",
                      )}
                      onContextMenu={(event) => {
                        openRowMenu(event, row);
                      }}
                    >
                      <button
                        type="button"
                        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-apple-sm hover:bg-[var(--cf-surface-hover)]"
                        style={{ marginLeft: `${row.depth * 16}px` }}
                        onClick={() => {
                          toggleExpanded(row.key);
                        }}
                      >
                        {row.expanded ? (
                          <ChevronDown className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-2 text-left"
                        onClick={() => {
                          setActiveRowKey(row.key);
                        }}
                        onDoubleClick={() => {
                          toggleExpanded(row.key);
                        }}
                        title={row.label}
                      >
                        <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--cf-text-secondary)]" />
                        <span className={cn("truncate", archived ? "text-[var(--cf-text-secondary)]" : "text-[var(--cf-text-primary)]")}>
                          {row.label}
                        </span>
                      </button>
                      <span className="truncate text-[11px] text-[var(--cf-text-secondary)]">
                        {formatShelfBrowserDirectorySummary(row, gt)}
                      </span>
                    </div>
                  );
                }

                if (row.kind === "shelf") {
                  const title = row.shelf.message || row.shelf.displayName || row.shelf.ref;
                  const summary = formatShelfBrowserDirectorySummary({
                    fileCount: row.fileCount,
                    directoryCount: row.directoryCount,
                  }, gt);
                  return (
                    <div
                      key={row.key}
                      className={cn(
                        "cf-git-list-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 px-2 py-2 text-xs",
                        selected ? "cf-git-row-selected" : "",
                      )}
                      onContextMenu={(event) => {
                        openRowMenu(event, row);
                      }}
                    >
                      {isExpandableShelfRow(row) ? (
                        <button
                          type="button"
                          className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-apple-sm hover:bg-[var(--cf-surface-hover)]"
                          style={{ marginLeft: `${row.depth * 16}px` }}
                          onClick={() => {
                            toggleExpanded(row.key);
                          }}
                        >
                          {row.expanded ? (
                            <ChevronDown className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                          )}
                        </button>
                      ) : (
                        <span className="h-4 w-4 shrink-0" style={{ marginLeft: `${row.depth * 16}px` }} />
                      )}
                      <button
                        type="button"
                        className="min-w-0 text-left"
                        onClick={() => {
                          setActiveRowKey(row.key);
                        }}
                        onDoubleClick={() => {
                          runPrimaryAction(row);
                        }}
                        title={title}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <div className={cn("truncate font-medium", archived ? "text-[var(--cf-text-secondary)]" : "text-[var(--cf-text-primary)]")}>
                            {title}
                          </div>
                          {row.shelf.originalChangeListName ? <Badge variant="secondary" className="text-[10px]">{row.shelf.originalChangeListName}</Badge> : null}
                          {stateLabel ? <Badge variant="secondary" className="text-[10px]">{stateLabel}</Badge> : null}
                        </div>
                        <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-[var(--cf-text-secondary)]">
                          <span className="truncate">{row.shelf.ref}</span>
                          <span className="shrink-0">·</span>
                          <span className="truncate">{formatShelfDateText(row.shelf.createdAt)}</span>
                        </div>
                        {row.shelf.lastError ? (
                          <div className="mt-1 truncate text-[11px] text-[var(--cf-red)]" title={row.shelf.lastError}>
                            {row.shelf.lastError}
                          </div>
                        ) : null}
                      </button>
                      <span className="truncate pt-0.5 text-[11px] text-[var(--cf-text-secondary)]">
                        {summary}
                      </span>
                    </div>
                  );
                }

                return (
                  <div
                    key={row.key}
                    className={cn(
                      "cf-git-list-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 py-1.5 text-xs",
                      selected ? "cf-git-row-selected" : "",
                    )}
                    onContextMenu={(event) => {
                      openRowMenu(event, row);
                    }}
                  >
                    <span className="h-4 w-4 shrink-0" style={{ marginLeft: `${row.depth * 16}px` }} />
                    <button
                      type="button"
                      className="flex min-w-0 items-center gap-2 text-left"
                      onClick={() => {
                        setActiveRowKey(row.key);
                      }}
                      onDoubleClick={() => {
                        runPrimaryAction(row);
                      }}
                      title={row.path}
                    >
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[var(--cf-accent)]" />
                      <span className={cn("truncate", archived ? "text-[var(--cf-text-secondary)]" : "text-[var(--cf-text-primary)]")}>
                        {row.fileName}
                      </span>
                    </button>
                    <span className="truncate text-[11px] text-[var(--cf-text-secondary)]">{row.directory}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="cf-git-empty-panel px-3 py-4 text-xs text-[var(--cf-text-secondary)]">
              {gt("shelf.empty", "暂无搁置记录")}
            </div>
          )}
        </div>

        {stashItems.length > 0 ? (
          <div className="shrink-0 border-t border-[var(--cf-border)]">
            <div className="border-b border-[var(--cf-border)] px-3 py-2 text-[10px] font-apple-medium uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
              {gt("shelf.stash.title", "暂存列表")}
            </div>
            <div className="max-h-[188px] overflow-auto bg-[var(--cf-surface-solid)]">
              {stashItems.map((stash) => (
                <div key={stash.ref} className="cf-git-list-row border-b border-[var(--cf-border)] px-3 py-2 text-xs last:border-b-0">
                  <div className="truncate font-medium text-[var(--cf-text-primary)]">{stash.message || stash.ref}</div>
                  <div className="mt-1 truncate text-[11px] text-[var(--cf-text-secondary)]">
                    {stash.ref} · {formatShelfDateText(stash.date)}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button size="xs" variant="secondary" disabled={!onStashAction} onClick={() => { onStashAction?.(stash, "apply"); }}>
                      {gt("shelf.stash.apply", "应用...")}
                    </Button>
                    <Button size="xs" variant="secondary" disabled={!onStashAction} onClick={() => { onStashAction?.(stash, "pop"); }}>
                      {gt("shelf.stash.pop", "恢复...")}
                    </Button>
                    <Button size="xs" variant="secondary" disabled={!onStashAction} onClick={() => { onStashAction?.(stash, "branch"); }}>
                      {gt("shelf.stash.branch", "恢复为分支...")}
                    </Button>
                    <Button size="xs" variant="secondary" disabled={!onStashAction} onClick={() => { onStashAction?.(stash, "drop"); }}>
                      {gt("shelf.stash.drop", "删除")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <ContextMenu menu={menu} onClose={() => setMenu(null)} actionGroupId="shelf-browser">
        {renderContextMenuSections([
          (() => {
            const label = resolveShelfPrimaryActionLabel(menuRow, gt);
            if (!label) return [];
            return [
              <ContextMenuItem
                key="primary"
                label={label}
                onClick={() => {
                  setMenu(null);
                  runPrimaryAction(menuRow);
                }}
              />,
            ];
          })(),
          (() => {
            if (!menuShelf || menuSelectionPaths.length <= 0) return [];
            return [
              <ContextMenuItem
                key="showDiff"
                label={gt("shelf.context.showDiff", "显示差异")}
                shortcut="Ctrl+D"
                disabled={!onRunDiffAction}
                onClick={() => {
                  setMenu(null);
                  runDiffAction(menuRow, "showDiff");
                }}
              />,
              <ContextMenuItem
                key="showStandaloneDiff"
                label={gt("shelf.context.showStandaloneDiff", "在新标签页中显示差异")}
                disabled={!onRunDiffAction}
                onClick={() => {
                  setMenu(null);
                  runDiffAction(menuRow, "showStandaloneDiff");
                }}
              />,
              <ContextMenuItem
                key="compareWithLocal"
                label={gt("shelf.context.compareWithLocal", "与本地比较")}
                disabled={!onRunDiffAction}
                onClick={() => {
                  setMenu(null);
                  runDiffAction(menuRow, "compareWithLocal");
                }}
              />,
              <ContextMenuItem
                key="createPatch"
                label={gt("shelf.context.createPatch", "创建补丁...")}
                disabled={!onCreatePatch}
                onClick={() => {
                  setMenu(null);
                  runCreatePatchAction(menuRow, "save");
                }}
              />,
              <ContextMenuItem
                key="copyPatch"
                label={gt("shelf.context.copyPatch", "作为补丁复制到剪贴板")}
                shortcut="F24"
                disabled={!onCreatePatch}
                onClick={() => {
                  setMenu(null);
                  runCreatePatchAction(menuRow, "clipboard");
                }}
              />,
              <ContextMenuItem
                key="import"
                label={gt("shelf.importPatch", "导入补丁...")}
                onClick={() => {
                  setMenu(null);
                  onImportPatch();
                }}
              />,
            ];
          })(),
          (() => {
            if (!menuShelf) return [];
            return [
              <ContextMenuItem
                key="rename"
                label={gt("shelf.context.rename", "重命名...")}
                onClick={() => {
                  setMenu(null);
                  runRenameAction(menuRow);
                }}
              />,
              <ContextMenuItem
                key="delete"
                label={resolveShelfDeleteActionLabel(menuRow, gt) || gt("shelf.deleteAction", "删除...")}
                tone={isArchivedShelfItem(menuShelf) ? "danger" : "default"}
                onClick={() => {
                  setMenu(null);
                  runDeleteAction(menuRow);
                }}
              />,
            ];
          })(),
          (() => {
            if (menuShelf) return [];
            return [
              <ContextMenuItem
                key="import-fallback"
                label={gt("shelf.importPatch", "导入补丁...")}
                onClick={() => {
                  setMenu(null);
                  onImportPatch();
                }}
              />,
            ];
          })(),
        ])}
      </ContextMenu>
    </>
  );
}
