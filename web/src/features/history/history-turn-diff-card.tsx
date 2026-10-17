// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Eye, FilePenLine, GitBranch, Loader2, MoreHorizontal, Redo2, RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import HistoryTurnDiffReviewDialog from "./history-turn-diff-review-dialog";
import { useHistoryDiffFileMenu } from "./history-diff-file-menu";
import { formatHistoryDiffPath, parseHistoryTurnDiff } from "./turn-diff";
import { historyDiffFileKey, resolveHistoryDiffPathBase, selectHistoryTurnDiffFiles, type HistoryDiffSource } from "./turn-diff-file-actions";



type HistoryTurnDiffCardProps = {
  diffText: string;
  projectWinPath?: string;
  cwd?: string;
  diffSource?: HistoryDiffSource;
  patchable?: boolean;
  onOpenGit?: () => void;
  className?: string;
};

/**
* 显示 Codex 单轮文件差异，并提供完整审核与经过校验的撤销入口。
*/
export default function HistoryTurnDiffCard({ diffText, projectWinPath, cwd, diffSource, patchable = true, onOpenGit, className }: HistoryTurnDiffCardProps) {
  const { t } = useTranslation(["history", "common", "git"]);
  const parsed = useMemo(() => parseHistoryTurnDiff(diffText), [diffText]);
  const pathBase = resolveHistoryDiffPathBase({ source: diffSource, format: parsed.format, projectWinPath, cwd });
  const patchContext = useMemo(() => ({ diffText, projectWinPath, cwd }), [diffText, projectWinPath, cwd]);
  const currentPatchContext = useRef(patchContext);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewFileRequest, setReviewFileRequest] = useState<{ path: string } | null>(null);
  const [patchAction, setPatchAction] = useState<"undo" | "reapply" | null>(null);
  const [revertedFiles, setRevertedFiles] = useState<Set<string>>(() => new Set());
  const patchActionLock = useRef(false);
  const [revertError, setRevertError] = useState("");
  const [showAllFiles, setShowAllFiles] = useState(false);
  const summaryFiles = parsed.summaryFiles.length > 0 ? parsed.summaryFiles : parsed.files;
  const visibleFiles = showAllFiles ? summaryFiles : summaryFiles.slice(0, 3);
  const hiddenFileCount = Math.max(0, summaryFiles.length - visibleFiles.length);
  const reverted = summaryFiles.length > 0 && summaryFiles.every((file) => revertedFiles.has(historyDiffFileKey(file.path)));
  const action = reverted ? "reapply" : "undo";
  const canPatchAction = patchable && !!projectWinPath && !!diffText.trim() && summaryFiles.length > 0 && summaryFiles.every((file) => file.path !== "unknown") && patchAction === null && !!window.host?.history?.revertTurnDiff;
  const gitLabel = String(t("git:workbench.misc.bottomTabs.git", "Git"));
  const title = summaryFiles.length === 1
    ? t("history:turnDiffEditedFile", { filename: formatHistoryDiffPath(summaryFiles[0]?.path || "", pathBase) })
    : t("history:turnDiffEditedFiles", { count: summaryFiles.length });

  useEffect(() => {
    currentPatchContext.current = patchContext;
    setRevertedFiles(new Set());
    setRevertError("");
    setShowAllFiles(false);
    setReviewFileRequest(null);
  }, [patchContext]);

  /**
   * 请求主进程先校验再应用所选文件补丁；整体操作跳过已处于目标状态的文件。
   */
  const handlePatchAction = async (filePath?: string): Promise<void> => {
    if (!projectWinPath || !diffText.trim() || !canPatchAction || patchActionLock.current) return;
    const operation = filePath ? (revertedFiles.has(historyDiffFileKey(filePath)) ? "reapply" : "undo") : action;
    const paths = filePath ? [filePath] : summaryFiles
      .filter((file) => revertedFiles.has(historyDiffFileKey(file.path)) === (operation === "reapply"))
      .map((file) => file.path);
    const selectedDiffText = selectHistoryTurnDiffFiles(diffText, paths);
    if (!selectedDiffText.trim()) return;
    if (filePath && operation === "undo" && !window.confirm(String(t("history:turnDiffUndoFileConfirm", { filename: formatHistoryDiffPath(filePath, pathBase) })))) return;
    patchActionLock.current = true;
    setPatchAction(operation);
    setRevertError("");
    try {
      const result = await window.host.history.revertTurnDiff({ projectWinPath, diffText: selectedDiffText, operation, cwd });
      if (currentPatchContext.current !== patchContext) return;
      if (!result.ok) {
        setRevertError(result.error || String(t(operation === "undo" ? "history:turnDiffRevertFailed" : "history:turnDiffReapplyFailed")));
        return;
      }
      setRevertedFiles((current) => {
        const next = new Set(current);
        for (const path of paths) {
          if (operation === "undo") next.add(historyDiffFileKey(path));
          else next.delete(historyDiffFileKey(path));
        }
        return next;
      });
    } catch (error) {
      if (currentPatchContext.current === patchContext)
        setRevertError(String((error as Error)?.message || error || t(operation === "undo" ? "history:turnDiffRevertFailed" : "history:turnDiffReapplyFailed")));
    } finally {
      patchActionLock.current = false;
      setPatchAction(null);
    }
  };

  /** 打开审核并直接聚焦用户选中的文件。 */
  const handleReviewFile = (path: string): void => {
    setReviewFileRequest({ path });
    setReviewOpen(true);
  };

  /** 查询当前文件在本张卡片中是否已经撤销。 */
  const isFileReverted = (path: string): boolean => revertedFiles.has(historyDiffFileKey(path));
  const { openFileMenu, menuNode } = useHistoryDiffFileMenu({
    projectWinPath, pathBase, canPatch: canPatchAction, isReverted: isFileReverted,
    onReview: handleReviewFile, onPatch: handlePatchAction, onError: setRevertError,
  });

  return (
    <>
      <div className={cn("min-w-0 overflow-hidden rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] shadow-apple-sm", className)}>
        <div className="flex min-w-0 flex-wrap items-center gap-3 px-3 py-2">
          <button
            type="button"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-apple bg-[var(--cf-surface-solid)] text-[var(--cf-text-secondary)] shadow-apple-sm transition-colors hover:bg-[var(--cf-accent-light)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[var(--cf-surface-solid)]"
            title={gitLabel}
            aria-label={gitLabel}
            disabled={!onOpenGit}
            onClick={onOpenGit}
          >
            <GitBranch className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-apple-semibold text-[var(--cf-text-primary)]">
              {reverted ? t("history:turnDiffReverted") : title}
            </div>
            <div className="mt-0.5 font-mono text-[11px] tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">+{parsed.additions}</span>{" "}
              <span className="text-red-600 dark:text-red-400">-{parsed.deletions}</span>
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2"
              disabled={!canPatchAction}
              onClick={() => { void handlePatchAction(); }}
            >
              {patchAction ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : action === "undo" ? <RotateCcw className="mr-1.5 h-4 w-4" /> : <Redo2 className="mr-1.5 h-4 w-4" />}
              {patchAction ? t(patchAction === "undo" ? "history:turnDiffReverting" : "history:turnDiffReapplying") : t(action === "undo" ? "history:turnDiffUndo" : "history:turnDiffReapply")}
            </Button>
            <Button size="sm" variant="secondary" className="h-8 px-2" onClick={() => { setReviewFileRequest(null); setReviewOpen(true); }}>
              <Eye className="mr-1.5 h-4 w-4" />
              {t("history:turnDiffReview")}
            </Button>
          </div>
        </div>

        {visibleFiles.length > 0 ? (
          <div className="flex flex-col border-t border-[var(--cf-border)] px-3 py-1">
            {visibleFiles.map((file, index) => (
              <div
                key={`${file.path}-${index}`}
                className="group/history-file -mx-1 flex min-h-9 min-w-0 items-center gap-1 rounded-md border border-transparent px-1 transition-colors hover:border-[var(--cf-border-strong)] hover:bg-[var(--cf-accent-light)] focus-within:border-[var(--cf-accent)] focus-within:bg-[var(--cf-accent-light)]"
                data-history-diff-summary-file={file.path}
                onContextMenu={(event) => openFileMenu(file.path, event)}
              >
                <button type="button" className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-start text-[11px] leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--cf-accent)]"
                  title={String(t("history:turnDiffReview"))} onClick={() => handleReviewFile(file.path)}>
                  <FilePenLine className="h-3.5 w-3.5 shrink-0 text-[var(--cf-accent)]" />
                  <span className="min-w-0 flex-1 truncate font-apple-medium text-[var(--cf-text-primary)]" title={file.path}>{formatHistoryDiffPath(file.path, pathBase)}</span>
                  {isFileReverted(file.path) ? <RotateCcw className="h-3.5 w-3.5 shrink-0 text-[var(--cf-text-muted)]" aria-label={String(t("history:turnDiffReverted"))} /> : null}
                  <span className="shrink-0 font-mono tabular-nums">
                    <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
                    <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
                  </span>
                </button>
                <button type="button" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-secondary)] transition-colors group-hover/history-file:text-[var(--cf-text-primary)] group-focus-within/history-file:text-[var(--cf-text-primary)] hover:bg-[var(--cf-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]"
                  aria-label={String(t("history:turnDiffFileMenu"))} title={String(t("history:turnDiffFileMenu"))} onClick={(event) => openFileMenu(file.path, event)}>
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </div>
            ))}
            {(hiddenFileCount > 0 || showAllFiles) ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-9 justify-start px-0 text-xs"
                onClick={() => setShowAllFiles((current) => !current)}
              >
                {showAllFiles
                  ? <>{t("history:turnDiffCollapseFiles")} <ChevronUp className="ml-1 h-3.5 w-3.5" /></>
                  : <>{t("history:turnDiffShowMoreFiles", { count: hiddenFileCount })} <ChevronDown className="ml-1 h-3.5 w-3.5" /></>}
              </Button>
            ) : null}
          </div>
        ) : null}
        {revertError ? (
          <div role="alert" className="flex gap-2 border-t border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 whitespace-pre-wrap break-words">{revertError}</span>
          </div>
        ) : null}
      </div>

      <HistoryTurnDiffReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        files={parsed.files}
        rawFileCount={parsed.rawFileCount}
        additions={parsed.additions}
        deletions={parsed.deletions}
        pathBase={pathBase}
        fileRequest={reviewFileRequest}
        onFileMenu={openFileMenu}
        actionError={revertError}
        action={action}
        patchAction={patchAction}
        canPatchAction={canPatchAction}
        onPatchAction={() => handlePatchAction()}
      />
      {menuNode}
    </>
  );
}
