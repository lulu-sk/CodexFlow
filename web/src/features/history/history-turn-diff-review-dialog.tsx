// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  FilePenLine,
  Focus,
  ListTree,
  Loader2,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Redo2,
  RotateCcw,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  buildHistoryDiffSplitRows,
  formatHistoryDiffPath,
  type HistoryDiffFile,
  type HistoryDiffLine,
} from "./turn-diff";
import { historyDiffFileKey } from "./turn-diff-file-actions";

type HistoryDiffViewType = "unified" | "split";

type HistoryTurnDiffReviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: HistoryDiffFile[];
  rawFileCount: number;
  additions: number;
  deletions: number;
  pathBase?: string;
  fileRequest?: { path: string } | null;
  onFileMenu: (path: string, event: MouseEvent<HTMLElement>) => void;
  actionError?: string;
  action: "undo" | "reapply";
  patchAction: "undo" | "reapply" | null;
  canPatchAction: boolean;
  onPatchAction: () => void | Promise<void>;
};

/**
 * 返回统一差异行对应的语义颜色，确保增删信息不只依赖前缀字符。
 */
function resolveDiffLineClassName(line: HistoryDiffLine): string {
  if (line.kind === "addition") return "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-100";
  if (line.kind === "deletion") return "bg-red-50 text-red-900 dark:bg-red-950/45 dark:text-red-100";
  if (line.kind === "hunk") return "bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200";
  if (line.kind === "meta") return "bg-[var(--cf-surface-muted)] text-[var(--cf-text-secondary)]";
  return "text-[var(--cf-text-primary)]";
}

/**
 * 去掉统一差异行开头的语义字符，只保留实际代码内容。
 */
function resolveDisplayedDiffText(line: HistoryDiffLine): string {
  if (line.kind === "addition" || line.kind === "deletion" || line.kind === "context")
    return line.text.slice(1);
  return line.text;
}

/**
 * 绘制与 Codex 插件一致的上下比较图标。
 */
function UnifiedDiffIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 24 24" fill="none">
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" stroke="currentColor" strokeWidth="2" />
      <path className="fill-red-500/50 dark:fill-red-400/50" d="M6 8C6 7.44772 6.44772 7 7 7H17C17.5523 7 18 7.44772 18 8V10.25C18 10.8023 17.5523 11.25 17 11.25H7C6.44772 11.25 6 10.8023 6 10.25V8Z" />
      <path className="fill-emerald-500/50 dark:fill-emerald-400/50" d="M6 13.75C6 13.1977 6.44772 12.75 7 12.75H17C17.5523 12.75 18 13.1977 18 13.75V16C18 16.5523 17.5523 17 17 17H7C6.44772 17 6 16.5523 6 16V13.75Z" />
    </svg>
  );
}

/**
 * 绘制与 Codex 插件一致的左右比较图标。
 */
function SplitDiffIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 24 24" fill="none">
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" stroke="currentColor" strokeWidth="2" />
      <path className="fill-red-500/50 dark:fill-red-400/50" d="M6 8C6 7.44772 6.44772 7 7 7H10.25C10.8023 7 11.25 7.44772 11.25 8V16C11.25 16.5523 10.8023 17 10.25 17H7C6.44772 17 6 16.5523 6 16V8Z" />
      <path className="fill-emerald-500/50 dark:fill-emerald-400/50" d="M12.75 8C12.75 7.44772 13.1977 7 13.75 7H17C17.5523 7 18 7.44772 18 8V16C18 16.5523 17.5523 17 17 17H13.75C13.1977 17 12.75 16.5523 12.75 16V8Z" />
    </svg>
  );
}

/**
 * 渲染一行带新旧行号的统一差异。
 */
function HistoryDiffLineRow({ line, unmodifiedLinesLabel }: { line: HistoryDiffLine; unmodifiedLinesLabel?: string }) {
  if (line.kind === "meta") return null;
  if (line.kind === "hunk") {
    const unchangedLines = Math.max(0, Number(line.unchangedLines || 0));
    if (unchangedLines === 0) return null;
    return (
      <div className="min-w-[29.5rem] px-2 py-1 font-apple text-[11px] text-[var(--cf-text-secondary)]">
        <div className="rounded-md bg-[var(--cf-surface-muted)] px-2 py-1">
          {unmodifiedLinesLabel}
        </div>
      </div>
    );
  }

  const displayedText = resolveDisplayedDiffText(line);
  return (
    <div
      className={cn(
        "grid min-w-max grid-cols-[2.75rem_2.75rem_minmax(24rem,1fr)] font-mono text-xs leading-6 tabular-nums",
        resolveDiffLineClassName(line),
      )}
    >
      <span className="select-none border-r border-[var(--cf-border)]/60 px-1.5 text-right text-[var(--cf-text-muted)]">
        {line.oldLine ?? ""}
      </span>
      <span className="select-none border-r border-[var(--cf-border)]/60 px-1.5 text-right text-[var(--cf-text-muted)]">
        {line.newLine ?? ""}
      </span>
      <code className="whitespace-pre px-2">
        {line.kind === "addition" ? <span className="sr-only">+ </span> : null}
        {line.kind === "deletion" ? <span className="sr-only">- </span> : null}
        {displayedText || " "}
      </code>
    </div>
  );
}

/**
 * 渲染左右比较中的单侧代码与对应行号。
 */
function HistoryDiffSplitCell({ line, side }: { line: HistoryDiffLine | null; side: "left" | "right" }) {
  if (!line) {
    return (
      <div
        aria-hidden="true"
        className="grid min-h-6 grid-cols-[3rem_minmax(26rem,1fr)] bg-[var(--cf-surface-muted)]/70 font-mono text-xs leading-6"
        data-history-diff-row="content"
        data-history-diff-side={side}
      >
        <span className="border-r border-[var(--cf-border)]/60" />
        <code className="px-2"> </code>
      </div>
    );
  }

  const lineNumber = side === "left" ? line.oldLine : line.newLine;
  const displayedText = resolveDisplayedDiffText(line);
  return (
    <div
      className={cn(
        "grid min-h-6 grid-cols-[3rem_minmax(26rem,1fr)] font-mono text-xs leading-6 tabular-nums",
        resolveDiffLineClassName(line),
      )}
      data-history-diff-row="content"
      data-history-diff-side={side}
    >
      <span className="select-none border-r border-[var(--cf-border)]/60 px-1.5 text-right text-[var(--cf-text-muted)]">
        {lineNumber ?? ""}
      </span>
      <code className="whitespace-pre px-2">
        {line.kind === "addition" ? <span className="sr-only">+ </span> : null}
        {line.kind === "deletion" ? <span className="sr-only">- </span> : null}
        {displayedText || " "}
      </code>
    </div>
  );
}

/**
 * 渲染一个文件的左右比较行，完整保留上下文与省略行提示。
 */
function HistoryDiffSplitRows({ lines }: { lines: HistoryDiffLine[] }) {
  const { t } = useTranslation("history");
  const rows = useMemo(() => buildHistoryDiffSplitRows(lines), [lines]);
  return (
    <div
      className="grid min-w-0 grid-cols-2 divide-x divide-[var(--cf-border)]/70"
      data-history-diff-view="split"
    >
      {(["left", "right"] as const).map((side) => (
        <div
          key={side}
          className="min-w-0 overflow-x-auto"
          data-history-diff-horizontal-scroll={side}
          data-history-diff-pane={side}
        >
          <div className="w-max min-w-full">
            {rows.map((row, index) => row.kind === "hunk" ? (
              <div
                key={`hunk-${side}-${row.unchangedLines}-${index}`}
                aria-hidden={side === "right" ? true : undefined}
                className="px-2 py-1 font-apple text-[11px] text-[var(--cf-text-secondary)]"
                data-history-diff-row="hunk"
              >
                <div className="rounded-md bg-[var(--cf-surface-muted)] px-2 py-1">
                  {side === "left"
                    ? t("history:turnDiffUnmodifiedLines", { count: row.unchangedLines })
                    : "\u00a0"}
                </div>
              </div>
            ) : (
              <HistoryDiffSplitCell
                key={`content-${side}-${row.left?.oldLine ?? "empty"}-${row.right?.newLine ?? "empty"}-${index}`}
                line={row[side]}
                side={side}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 渲染上下与左右比较模式的分段切换按钮。
 */
function HistoryDiffViewToggle({
  value,
  onChange,
}: {
  value: HistoryDiffViewType;
  onChange: (value: HistoryDiffViewType) => void;
}) {
  const { t } = useTranslation("history");
  const buttonClassName = "flex h-9 w-9 items-center justify-center rounded-md transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/45";
  return (
    <div
      role="group"
      aria-label={String(t("history:turnDiffViewMode"))}
      className="flex shrink-0 items-center gap-0.5 rounded-apple bg-[var(--cf-surface-muted)] p-0.5"
    >
      <button
        type="button"
        aria-label={String(t("history:turnDiffUnifiedView"))}
        aria-pressed={value === "unified"}
        title={String(t("history:turnDiffUnifiedView"))}
        className={cn(
          buttonClassName,
          value === "unified"
            ? "bg-[var(--cf-surface-solid)] text-[var(--cf-text-primary)] shadow-apple-sm"
            : "text-[var(--cf-text-secondary)] hover:bg-[var(--cf-surface-solid)]/70",
        )}
        onClick={() => onChange("unified")}
      >
        <UnifiedDiffIcon className="h-5 w-5" />
      </button>
      <button
        type="button"
        aria-label={String(t("history:turnDiffSplitView"))}
        aria-pressed={value === "split"}
        title={String(t("history:turnDiffSplitView"))}
        className={cn(
          buttonClassName,
          value === "split"
            ? "bg-[var(--cf-surface-solid)] text-[var(--cf-text-primary)] shadow-apple-sm"
            : "text-[var(--cf-text-secondary)] hover:bg-[var(--cf-surface-solid)]/70",
        )}
        onClick={() => onChange("split")}
      >
        <SplitDiffIcon className="h-5 w-5" />
      </button>
    </div>
  );
}

/**
 * 渲染单个文件的完整差异区块及聚焦入口。
 */
function HistoryDiffFileBlock({
  file,
  displayPath,
  fileIndex,
  viewType,
  isFocused,
  onToggleFocus,
  onFileMenu,
}: {
  file: HistoryDiffFile;
  displayPath: string;
  fileIndex: number;
  viewType: HistoryDiffViewType;
  isFocused: boolean;
  onToggleFocus: () => void;
  onFileMenu: (path: string, event: MouseEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation("history");
  const focusLabel = isFocused
    ? String(t("history:turnDiffShowAllFiles"))
    : String(t("history:turnDiffFocusFile", { filename: displayPath }));
  return (
    <section
      className="min-w-0 overflow-hidden rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)]"
      data-history-diff-file-index={fileIndex}
      onContextMenu={(event) => onFileMenu(file.path, event)}
    >
      <div className="flex min-w-0 items-center gap-3 border-b border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-3 py-1.5">
        <span className="truncate text-xs font-apple-semibold text-[var(--cf-text-primary)]" title={file.path}>{displayPath}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="font-mono text-[11px] tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
            <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
          </span>
          <button type="button" aria-label={String(t("history:turnDiffFileMenu"))} title={String(t("history:turnDiffFileMenu"))}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--cf-text-secondary)] hover:bg-[var(--cf-accent-light)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/45"
            onClick={(event) => onFileMenu(file.path, event)}>
            <MoreHorizontal className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={focusLabel}
            aria-pressed={isFocused}
            title={focusLabel}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--cf-text-secondary)] transition-colors motion-reduce:transition-none hover:bg-[var(--cf-accent-light)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/45"
            onClick={onToggleFocus}
          >
            {isFocused ? <ListTree className="h-4 w-4" /> : <Focus className="h-4 w-4" />}
          </button>
        </div>
      </div>
      {viewType === "split" ? (
        <HistoryDiffSplitRows lines={file.lines} />
      ) : (
        <div className="max-w-full overflow-x-auto" data-history-diff-horizontal-scroll="unified">
          <div data-history-diff-view="unified">
            {file.lines.map((line, index) => (
              <HistoryDiffLineRow
                key={`${file.path}-${line.kind}-${line.oldLine ?? "empty"}-${line.newLine ?? "empty"}-${index}`}
                line={line}
                unmodifiedLinesLabel={line.kind === "hunk" && Number(line.unchangedLines || 0) > 0
                  ? String(t("history:turnDiffUnmodifiedLines", { count: line.unchangedLines }))
                  : undefined}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 显示近全屏的历史差异审核界面，并管理视图、文件导航与单文件聚焦状态。
 */
export default function HistoryTurnDiffReviewDialog({
  open,
  onOpenChange,
  files,
  rawFileCount,
  additions,
  deletions,
  pathBase,
  fileRequest,
  onFileMenu,
  actionError,
  action,
  patchAction,
  canPatchAction,
  onPatchAction,
}: HistoryTurnDiffReviewDialogProps) {
  const { t } = useTranslation(["history", "common"]);
  const fileListId = useId();
  const reviewScrollRef = useRef<HTMLDivElement>(null);
  const [fileListOpen, setFileListOpen] = useState(false);
  const [viewType, setViewType] = useState<HistoryDiffViewType>("unified");
  const [focusedFileIndex, setFocusedFileIndex] = useState<number | null>(null);
  const fileEntries = useMemo(() => {
    const occurrences = new Map<string, number>();
    return files.map((file, index) => {
      const occurrence = (occurrences.get(file.path) || 0) + 1;
      occurrences.set(file.path, occurrence);
      return {
        file,
        index,
        key: JSON.stringify([file.path, occurrence]),
        displayPath: formatHistoryDiffPath(file.path, pathBase),
      };
    });
  }, [files, pathBase]);
  const focusedFileEntry = focusedFileIndex === null
    ? null
    : fileEntries.find((entry) => entry.index === focusedFileIndex) || null;
  const visibleFileEntries = focusedFileEntry
    ? fileEntries.filter((entry) => historyDiffFileKey(entry.file.path) === historyDiffFileKey(focusedFileEntry.file.path))
    : fileEntries;
  const patchActionLabel = patchAction
    ? t(patchAction === "undo" ? "history:turnDiffReverting" : "history:turnDiffReapplying")
    : t(action === "undo" ? "history:turnDiffUndo" : "history:turnDiffReapply");

  useEffect(() => {
    setFileListOpen(false);
    setViewType("unified");
    setFocusedFileIndex(fileRequest
      ? files.findIndex((file) => historyDiffFileKey(file.path) === historyDiffFileKey(fileRequest.path))
      : null);
  }, [files, fileRequest, open]);

  /**
   * 将审核内容滚回顶部，避免切换文件后保留旧文件的滚动位置。
   */
  const scrollReviewToTop = (): void => {
    if (reviewScrollRef.current) reviewScrollRef.current.scrollTop = 0;
  };

  /**
   * 从文件列表聚焦指定差异段。
   */
  const handleFocusFile = (fileIndex: number): void => {
    setFocusedFileIndex(fileIndex);
    scrollReviewToTop();
  };

  /**
   * 在文件标题中切换单文件聚焦与全部文件模式。
   */
  const handleToggleFileFocus = (fileIndex: number): void => {
    setFocusedFileIndex((current) => current === fileIndex ? null : fileIndex);
    scrollReviewToTop();
  };

  /**
   * 恢复显示当前审核中的全部文件差异段。
   */
  const handleShowAllFiles = (): void => {
    setFocusedFileIndex(null);
    scrollReviewToTop();
  };

  /**
   * 关闭审核弹窗并执行已经过卡片校验的撤销或重新应用操作。
   */
  const handlePatchAction = (): void => {
    onOpenChange(false);
    void onPatchAction();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[calc(100vh-1rem)] max-h-none w-[calc(100vw-1rem)] max-w-none flex-col overflow-hidden rounded-apple-lg p-0"
        style={{ maxHeight: "none" }}
      >
        <DialogHeader className="mb-0 shrink-0 border-b border-[var(--cf-border)] px-2 py-1.5">
          <DialogTitle className="sr-only mb-0">{t("history:turnDiffReviewTitle")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("history:turnDiffReviewChangedFiles", { count: rawFileCount })}
          </DialogDescription>
          <div
            role="toolbar"
            aria-label={String(t("history:turnDiffReviewToolbar"))}
            className="flex min-h-10 min-w-0 items-center gap-2"
          >
            <button
              type="button"
              aria-controls={fileListId}
              aria-expanded={fileListOpen}
              aria-label={String(t(fileListOpen ? "history:turnDiffHideFileList" : "history:turnDiffShowFileList"))}
              title={String(t(fileListOpen ? "history:turnDiffHideFileList" : "history:turnDiffShowFileList"))}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-secondary)] transition-colors motion-reduce:transition-none hover:bg-[var(--cf-accent-light)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/45"
              onClick={() => setFileListOpen((current) => !current)}
            >
              {fileListOpen ? <PanelLeftClose className="h-5 w-5" /> : <PanelLeftOpen className="h-5 w-5" />}
            </button>
            <div className="flex min-w-0 shrink-0 items-center gap-2 text-sm">
              <FilePenLine className="h-4 w-4 shrink-0 text-[var(--cf-text-secondary)]" />
              <span className="hidden whitespace-nowrap text-[var(--cf-text-primary)] sm:inline">
                {t("history:turnDiffReviewChangedFiles", { count: rawFileCount })}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{" "}
                <span className="text-red-600 dark:text-red-400">-{deletions}</span>
              </span>
            </div>
            {focusedFileEntry ? (
              <button
                type="button"
                aria-label={String(t("history:turnDiffShowAllFiles"))}
                title={String(t("history:turnDiffShowAllFiles"))}
                className="flex h-9 min-w-0 max-w-[30vw] items-center gap-1.5 rounded-md bg-[var(--cf-accent-light)] px-2 text-xs text-[var(--cf-text-primary)] transition-colors motion-reduce:transition-none hover:bg-[var(--cf-accent-light)]/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/45"
                onClick={handleShowAllFiles}
              >
                <Focus className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden truncate md:inline">{focusedFileEntry.displayPath}</span>
                <X className="h-3.5 w-3.5 shrink-0" />
              </button>
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <HistoryDiffViewToggle value={viewType} onChange={setViewType} />
              <Button
                size="sm"
                variant="secondary"
                className="h-9 px-2"
                disabled={!canPatchAction}
                aria-label={String(patchActionLabel)}
                title={String(patchActionLabel)}
                onClick={handlePatchAction}
              >
                {patchAction
                  ? <Loader2 className="h-4 w-4 animate-spin sm:mr-1.5" />
                  : action === "undo"
                    ? <RotateCcw className="h-4 w-4 sm:mr-1.5" />
                    : <Redo2 className="h-4 w-4 sm:mr-1.5" />}
                <span className="hidden sm:inline">{patchActionLabel}</span>
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-9 w-9"
                aria-label={String(t("common:close"))}
                title={String(t("common:close"))}
                onClick={() => onOpenChange(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </DialogHeader>
        {actionError ? <div role="alert" className="shrink-0 whitespace-pre-wrap break-words border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200">{actionError}</div> : null}
        <div className="relative isolate flex min-h-0 flex-1 overflow-hidden">
          {fileListOpen ? (
            <>
              <button
                type="button"
                aria-label={String(t("history:turnDiffHideFileList"))}
                className="absolute inset-0 z-10 bg-black/20 xl:hidden"
                onClick={() => setFileListOpen(false)}
              />
              <aside
                id={fileListId}
                aria-label={String(t("history:turnDiffFileList"))}
                className="absolute inset-y-0 left-0 z-20 flex w-[min(19rem,calc(100%-2rem))] flex-col border-r border-[var(--cf-border)] bg-[var(--cf-surface-solid)] shadow-apple-xl xl:static xl:z-auto xl:w-72 xl:shrink-0 xl:shadow-none"
              >
                <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
                  <ListTree className="h-4 w-4 text-[var(--cf-text-secondary)]" />
                  <span className="min-w-0 flex-1 truncate text-sm font-apple-semibold text-[var(--cf-text-primary)]">
                    {t("history:turnDiffFileList")}
                  </span>
                  <button
                    type="button"
                    aria-label={String(t("history:turnDiffHideFileList"))}
                    title={String(t("history:turnDiffHideFileList"))}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--cf-text-secondary)] transition-colors motion-reduce:transition-none hover:bg-[var(--cf-accent-light)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/45"
                    onClick={() => setFileListOpen(false)}
                  >
                    <PanelLeftClose className="h-4 w-4" />
                  </button>
                </div>
                <ScrollArea className="min-h-0 flex-1 p-2">
                  <nav aria-label={String(t("history:turnDiffFileList"))} className="space-y-1">
                    <button
                      type="button"
                      aria-pressed={focusedFileEntry === null}
                      data-history-diff-file-selection="all"
                      className={cn(
                        "flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-2 text-start text-xs transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/45",
                        focusedFileEntry === null
                          ? "bg-[var(--cf-accent-light)] font-apple-semibold text-[var(--cf-text-primary)]"
                          : "text-[var(--cf-text-secondary)] hover:bg-[var(--cf-accent-light)]/60",
                      )}
                      onClick={handleShowAllFiles}
                    >
                      <ListTree className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{t("history:turnDiffShowAllFiles")}</span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums">{fileEntries.length}</span>
                    </button>
                    {fileEntries.map((entry) => {
                      const selected = focusedFileEntry?.index === entry.index;
                      return (
                        <button
                          key={entry.key}
                          type="button"
                          aria-pressed={selected}
                          data-history-diff-file-selection={entry.index}
                          className={cn(
                            "flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 py-2 text-start transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/45",
                            selected
                              ? "bg-[var(--cf-accent-light)] text-[var(--cf-text-primary)]"
                              : "text-[var(--cf-text-secondary)] hover:bg-[var(--cf-accent-light)]/60",
                          )}
                          title={entry.file.path}
                          onClick={() => handleFocusFile(entry.index)}
                          onContextMenu={(event) => onFileMenu(entry.file.path, event)}
                        >
                          <FilePenLine className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 flex-1 truncate text-xs">{entry.displayPath}</span>
                          <span className="shrink-0 font-mono text-[10px] tabular-nums">
                            <span className="text-emerald-600 dark:text-emerald-400">+{entry.file.additions}</span>{" "}
                            <span className="text-red-600 dark:text-red-400">-{entry.file.deletions}</span>
                          </span>
                        </button>
                      );
                    })}
                  </nav>
                </ScrollArea>
              </aside>
            </>
          ) : null}
          <ScrollArea
            ref={reviewScrollRef}
            className="relative z-0 min-h-0 min-w-0 flex-1 overflow-x-hidden bg-[var(--cf-surface-muted)]/35"
            data-history-diff-content="true"
          >
            <div className="space-y-2 p-2">
              {visibleFileEntries.map((entry) => (
                <HistoryDiffFileBlock
                  key={entry.key}
                  file={entry.file}
                  displayPath={entry.displayPath}
                  fileIndex={entry.index}
                  viewType={viewType}
                  isFocused={focusedFileEntry?.index === entry.index}
                  onToggleFocus={() => handleToggleFileFocus(entry.index)}
                  onFileMenu={onFileMenu}
                />
              ))}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
